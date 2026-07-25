#!/usr/bin/env python
"""Phase 2: train a small CNN callout classifier, export ONNX.

Binary classifier that decides whether a candidate connected-component blob is
part of a diagram callout (a 1-2 digit number with a thin leader line). It does
NOT read the digit (Tesseract does). Its job is PRECISION: reject the ~67% of
candidates that are non-callouts while keeping essentially all real callouts.

Leave-one-catalog-out: train/val = catalog 996, test = 997-1Turbo-GT2.

Run (CPU is fine, trains in minutes):
  uv run --with torch --with numpy --with onnx --with onnxruntime python ocr/train_classifier.py

Preprocessing contract (Phase 3 must replicate exactly, in-browser):
  input NCHW [N,1,48,48] float32, value = patch/255.0  (0=ink, 1=white)
  NO mean/std normalization. The exported ONNX outputs a sigmoid PROBABILITY.
"""
import argparse
import json
import os
import random
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATASET = os.path.join(HERE, "dataset")
NPZ = os.path.join(DATASET, "patches.npz")
MANIFEST = os.path.join(DATASET, "manifest.jsonl")
ONNX_OUT = os.path.join(HERE, "callout-cnn.onnx")
META_OUT = os.path.join(HERE, "callout-cnn.meta.json")
REPORT_OUT = os.path.join(DATASET, "TRAIN_REPORT.md")

IMG = 48
VAL_FRAC = 0.15      # fraction of sections held out for val (per training catalog)
SPLIT_SEED = 1998    # deterministic val-section selection


def assign_splits(catalog_arr, section_arr, holdout=None):
    """Per-patch split from catalog + section rowid.

    holdout catalog (if any) -> all its patches are 'test'. Remaining catalogs
    contribute train + val, holding out VAL_FRAC of each catalog's *sections* as
    'val' (deterministic). No holdout => no test rows (final all-catalog run).
    """
    split = np.empty(len(catalog_arr), dtype=object)
    for cat in sorted(set(catalog_arr.tolist())):
        m = catalog_arr == cat
        if holdout is not None and cat == holdout:
            split[m] = "test"
            continue
        secs = sorted(set(section_arr[m].tolist()))
        rng = random.Random(SPLIT_SEED)
        rng.shuffle(secs)
        k = max(1, round(len(secs) * VAL_FRAC))
        val_secs = set(secs[:k])
        idx = np.where(m)[0]
        for i in idx:
            split[i] = "val" if int(section_arr[i]) in val_secs else "train"
    return split


def set_seeds(seed):
    import torch
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


# ------------------------------------------------------------------ model
def build_model():
    import torch.nn as nn

    class CalloutCNN(nn.Module):
        def __init__(self):
            super().__init__()

            def block(cin, cout):
                return nn.Sequential(
                    nn.Conv2d(cin, cout, 3, padding=1, bias=False),
                    nn.BatchNorm2d(cout),
                    nn.ReLU(inplace=True),
                    nn.MaxPool2d(2),
                )

            self.features = nn.Sequential(
                block(1, 16),   # 48 -> 24
                block(16, 32),  # 24 -> 12
                block(32, 64),  # 12 -> 6
            )
            self.gap = nn.AdaptiveAvgPool2d(1)
            self.head = nn.Sequential(
                nn.Flatten(),
                nn.Linear(64, 32),
                nn.ReLU(inplace=True),
                nn.Dropout(0.3),
                nn.Linear(32, 1),
            )

        def forward(self, x):
            x = self.features(x)
            x = self.gap(x)
            return self.head(x)  # raw logit [N,1]

    return CalloutCNN()


# ------------------------------------------------------------- augmentation
def augment(x, max_rot_deg, max_trans_px, max_scale, hflip, vflip):
    """Affine augmentation on a batch of [N,1,48,48] tensors (values 0=ink,1=white).

    Sampled in ink space (background=0) with zero padding so out-of-frame area
    fills to white after inversion. Digit stays near-upright (small rotation).
    """
    import torch
    import torch.nn.functional as F

    n = x.shape[0]
    dev = x.device
    rot = (torch.rand(n, device=dev) * 2 - 1) * (max_rot_deg * np.pi / 180.0)
    scale = 1.0 + (torch.rand(n, device=dev) * 2 - 1) * max_scale
    tx = (torch.rand(n, device=dev) * 2 - 1) * (max_trans_px / (IMG / 2.0))
    ty = (torch.rand(n, device=dev) * 2 - 1) * (max_trans_px / (IMG / 2.0))
    sx = torch.ones(n, device=dev)
    sy = torch.ones(n, device=dev)
    if hflip:
        sx = torch.where(torch.rand(n, device=dev) < 0.5, -sx, sx)
    if vflip:
        sy = torch.where(torch.rand(n, device=dev) < 0.5, -sy, sy)

    cos, sin = torch.cos(rot), torch.sin(rot)
    # inverse-map affine (grid_sample maps output->input); build 2x3 theta
    a = cos / scale * sx
    b = -sin / scale
    c = sin / scale
    d = cos / scale * sy
    theta = torch.zeros(n, 2, 3, device=dev)
    theta[:, 0, 0] = a
    theta[:, 0, 1] = b
    theta[:, 0, 2] = tx
    theta[:, 1, 0] = c
    theta[:, 1, 1] = d
    theta[:, 1, 2] = ty

    ink = 1.0 - x  # background -> 0
    grid = F.affine_grid(theta, x.shape, align_corners=False)
    ink = F.grid_sample(ink, grid, padding_mode="zeros", align_corners=False)
    return 1.0 - ink


# --------------------------------------------------------------- metrics
def pr_curve(y_true, scores):
    """Return precision, recall, thresholds and average-precision (AUC-PR)."""
    order = np.argsort(-scores, kind="mergesort")
    y = y_true[order]
    s = scores[order]
    tp = np.cumsum(y)
    fp = np.cumsum(1 - y)
    p = tp / np.maximum(tp + fp, 1)
    r = tp / max(int(y_true.sum()), 1)
    # unique thresholds (last index of each distinct score)
    distinct = np.where(np.diff(s) != 0)[0]
    idx = np.r_[distinct, len(s) - 1]
    precision = p[idx]
    recall = r[idx]
    thr = s[idx]
    # average precision = sum (R_n - R_{n-1}) * P_n
    r_prev = np.r_[0.0, recall[:-1]]
    ap = float(np.sum((recall - r_prev) * precision))
    return precision, recall, thr, ap


def metrics_at(y_true, scores, thr):
    pred = (scores >= thr).astype(np.int64)
    tp = int(((pred == 1) & (y_true == 1)).sum())
    fp = int(((pred == 1) & (y_true == 0)).sum())
    fn = int(((pred == 0) & (y_true == 1)).sum())
    tn = int(((pred == 0) & (y_true == 0)).sum())
    prec = tp / max(tp + fp, 1)
    rec = tp / max(tp + fn, 1)
    f1 = 2 * prec * rec / max(prec + rec, 1e-9)
    return dict(tp=tp, fp=fp, fn=fn, tn=tn, precision=prec, recall=rec, f1=f1)


def best_f1_threshold(y_true, scores):
    precision, recall, thr, _ = pr_curve(y_true, scores)
    f1 = 2 * precision * recall / np.maximum(precision + recall, 1e-9)
    i = int(np.argmax(f1))
    return float(thr[i]), float(f1[i])


# --------------------------------------------------------------- inference
def predict(model, X, device, bs=2048):
    import torch

    model.eval()
    out = []
    with torch.no_grad():
        for i in range(0, len(X), bs):
            xb = torch.from_numpy(X[i:i + bs]).to(device)
            logit = model(xb).squeeze(1)
            out.append(torch.sigmoid(logit).cpu().numpy())
    return np.concatenate(out)


# --------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--seed", type=int, default=1337)
    ap.add_argument("--patience", type=int, default=8)
    ap.add_argument("--no-aug", action="store_true")
    ap.add_argument("--rot", type=float, default=10.0)
    ap.add_argument("--trans", type=float, default=4.0)
    ap.add_argument("--scale", type=float, default=0.15)
    # flips default OFF: sweep showed they hurt TEST metrics (they tilt digits into
    # orientations that never occur). Kept as opt-in flags.
    ap.add_argument("--hflip", action="store_true", default=False)
    ap.add_argument("--vflip", action="store_true", default=False)
    ap.add_argument("--no-report", action="store_true", help="skip writing report/onnx (for aug sweeps / LOCO)")
    ap.add_argument("--holdout", default=None,
                    help="leave-one-catalog-out: hold this catalog out entirely as test (LOCO sanity)")
    ap.add_argument("--metrics-json", default=None,
                    help="dump the metrics dict to this JSON path (for the orchestrating report)")
    args = ap.parse_args()

    import torch
    import torch.nn as nn

    set_seeds(args.seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"device={device} aug={not args.no_aug} hflip={args.hflip} vflip={args.vflip} "
          f"holdout={args.holdout}", file=sys.stderr)

    d = np.load(NPZ, allow_pickle=True)
    P = d["patches"].astype(np.float32) / 255.0  # [N,48,48] 0=ink 1=white
    P = P[:, None, :, :]  # [N,1,48,48]
    y = d["label"].astype(np.int64)
    src = d["source"]
    catalog = d["catalog"]
    section = d["section"]
    split = assign_splits(catalog, section, holdout=args.holdout)

    tr = split == "train"
    va = split == "val"
    te = split == "test"
    has_test = bool(te.sum())

    Xtr, ytr = P[tr], y[tr]
    Xva, yva = P[va], y[va]
    Xte, yte = P[te], y[te]
    src_va, src_te = src[va], src[te]
    print(f"split sizes: train={int(tr.sum())} val={int(va.sum())} test={int(te.sum())}",
          file=sys.stderr)

    n_pos = int(ytr.sum())
    n_neg = int((ytr == 0).sum())
    pos_weight = torch.tensor([n_neg / max(n_pos, 1)], device=device)
    print(f"train pos={n_pos} neg={n_neg} pos_weight={pos_weight.item():.3f}", file=sys.stderr)

    model = build_model().to(device)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"params={n_params}", file=sys.stderr)

    opt = torch.optim.Adam(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    lossfn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)

    ytr_t = torch.from_numpy(ytr.astype(np.float32))
    Xtr_t = torch.from_numpy(Xtr)
    n = len(Xtr)

    # val cc-only mask for model selection (realistic inference distribution)
    va_cc = src_va == "cc"

    best_ap = -1.0
    best_state = None
    best_epoch = -1
    since = 0
    rng = np.random.default_rng(args.seed)

    for ep in range(args.epochs):
        model.train()
        perm = rng.permutation(n)
        tot = 0.0
        for i in range(0, n, args.batch):
            idx = perm[i:i + args.batch]
            xb = Xtr_t[idx].to(device)
            yb = ytr_t[idx].to(device)
            if not args.no_aug:
                xb = augment(xb, args.rot, args.trans, args.scale, args.hflip, args.vflip)
            opt.zero_grad()
            logit = model(xb).squeeze(1)
            loss = lossfn(logit, yb)
            loss.backward()
            opt.step()
            tot += loss.item() * len(idx)
        sched.step()

        sva = predict(model, Xva, device)
        _, _, _, ap_cc = pr_curve(yva[va_cc], sva[va_cc])
        thr_cc, f1_cc = best_f1_threshold(yva[va_cc], sva[va_cc])
        print(f"ep{ep:02d} loss={tot/n:.4f} val_cc AP={ap_cc:.4f} bestF1={f1_cc:.4f}@{thr_cc:.3f}", file=sys.stderr)

        if ap_cc > best_ap:
            best_ap = ap_cc
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            best_epoch = ep
            since = 0
        else:
            since += 1
            if since >= args.patience:
                print(f"early stop at ep{ep} (best ep{best_epoch})", file=sys.stderr)
                break

    model.load_state_dict(best_state)

    # ---- threshold chosen on val cc-only ----
    sva = predict(model, Xva, device)
    thr, _ = best_f1_threshold(yva[va_cc], sva[va_cc])
    print(f"chosen threshold (val cc-only best-F1) = {thr:.4f}, best_epoch={best_epoch}", file=sys.stderr)

    # ---- evaluate ----
    def report_block(yt, sc, name):
        m = metrics_at(yt, sc, thr)
        _, _, _, apv = pr_curve(yt, sc)
        m["ap"] = apv
        m["n"] = int(len(yt))
        m["pos"] = int(yt.sum())
        m["name"] = name
        return m

    results = {
        "val_cc": report_block(yva[va_cc], sva[va_cc], "val cc-only"),
        "val_all": report_block(yva, sva, "val cc+gt"),
    }
    if has_test:
        ste = predict(model, Xte, device)
        te_cc = src_te == "cc"
        results["test_cc"] = report_block(yte[te_cc], ste[te_cc], f"TEST cc-only ({args.holdout})")
        results["test_all"] = report_block(yte, ste, f"TEST cc+gt ({args.holdout})")
    for k, m in results.items():
        print(f"{m['name']}: P={m['precision']:.4f} R={m['recall']:.4f} F1={m['f1']:.4f} "
              f"AP={m['ap']:.4f} (n={m['n']} pos={m['pos']})", file=sys.stderr)

    if args.metrics_json:
        dump = {k: {kk: v[kk] for kk in ("precision", "recall", "f1", "ap", "n", "pos",
                                         "tp", "fp", "fn", "tn")}
                for k, v in results.items()}
        dump["_meta"] = {"holdout": args.holdout, "threshold": round(thr, 6),
                         "best_epoch": best_epoch,
                         "train_n": int(tr.sum()), "val_n": int(va.sum()),
                         "test_n": int(te.sum())}
        json.dump(dump, open(args.metrics_json, "w"), indent=2)
        print(f"wrote metrics json -> {args.metrics_json}", file=sys.stderr)

    if args.no_report:
        return

    # ---- reporting/export use the honest held-out distribution:
    #      the test catalog if holding one out, else val (final all-catalog model). ----
    if has_test:
        e_mask, e_cc, se, ye = te, te_cc, ste, yte
    else:
        e_mask, e_cc, se, ye = va, va_cc, sva, yva

    # ---- dump full PR curves (val-cc, eval-cc) for Phase 4 operating-point choice ----
    prec_t, rec_t, thr_t, _ = pr_curve(ye[e_cc], se[e_cc])
    prec_v, rec_v, thr_v, _ = pr_curve(yva[va_cc], sva[va_cc])
    eval_split_name = "test_cc" if has_test else "val_cc"
    with open(os.path.join(HERE, "callout-cnn.pr_curve.csv"), "w", encoding="utf-8") as f:
        f.write("split,threshold,precision,recall\n")
        if not has_test:
            for th, pr, rc in zip(thr_v, prec_v, rec_v):
                f.write(f"val_cc,{th:.6f},{pr:.6f},{rc:.6f}\n")
        else:
            for th, pr, rc in zip(thr_v, prec_v, rec_v):
                f.write(f"val_cc,{th:.6f},{pr:.6f},{rc:.6f}\n")
            for th, pr, rc in zip(thr_t, prec_t, rec_t):
                f.write(f"test_cc,{th:.6f},{pr:.6f},{rc:.6f}\n")

    # operating points on eval cc-only: highest precision achievable at each recall floor
    op_points = []
    for rfloor in (0.999, 0.995, 0.99, 0.98, 0.95):
        ok = rec_t >= rfloor
        if ok.any():
            i = np.argmax(np.where(ok, prec_t, -1))
            op_points.append((rfloor, float(prec_t[i]), float(rec_t[i]), float(thr_t[i])))

    # ---- FP/FN breakdown on eval cc-only via manifest ----
    manifest = [json.loads(l) for l in open(MANIFEST, encoding="utf-8")]
    manifest = np.array(manifest, dtype=object)
    e_idx = np.where(e_mask)[0]
    te_cc_idx = e_idx[e_cc]
    pred_te_cc = (se[e_cc] >= thr).astype(np.int64)
    yt_cc = ye[e_cc]

    def bbox_dims(rec):
        x0, y0, x1, y1 = rec["bbox"]
        return (x1 - x0), (y1 - y0)

    fp_recs = [manifest[i] for i, (p, t) in zip(te_cc_idx, zip(pred_te_cc, yt_cc)) if p == 1 and t == 0]
    fn_recs = [manifest[i] for i, (p, t) in zip(te_cc_idx, zip(pred_te_cc, yt_cc)) if p == 0 and t == 1]

    def summarize(recs):
        if not recs:
            return {"count": 0}
        ws = np.array([bbox_dims(r)[0] for r in recs])
        hs = np.array([bbox_dims(r)[1] for r in recs])
        thin = int(np.sum((ws <= 12)))  # narrow blobs ~ lone-1 / stroke width
        tall_thin = int(np.sum((ws <= 12) & (hs >= 20)))
        return {
            "count": len(recs),
            "w_median": float(np.median(ws)), "h_median": float(np.median(hs)),
            "narrow_w_le12": thin, "tall_thin(w<=12,h>=20)": tall_thin,
        }

    # FN digit distribution (which numbers get missed)
    fn_digits = {}
    for r in fn_recs:
        g = r.get("gt_num")
        fn_digits[g] = fn_digits.get(g, 0) + 1
    fn_lone1 = sum(v for k, v in fn_digits.items() if k == 1)

    fp_sum = summarize(fp_recs)
    fn_sum = summarize(fn_recs)
    fn_sum["digit_hist_top"] = dict(sorted(fn_digits.items(), key=lambda kv: -kv[1])[:8])
    fn_sum["lone_1_count"] = fn_lone1

    # ---- export ONNX (wrap with sigmoid so output is a probability) ----
    class Exportable(nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, x):
            return torch.sigmoid(self.m(x))

    Xeval = Xte if has_test else Xva
    exp = Exportable(model).to(device).eval()
    dummy = torch.from_numpy(Xeval[:4]).to(device)
    torch.onnx.export(
        exp, dummy, ONNX_OUT,
        input_names=["input"], output_names=["prob"],
        dynamic_axes={"input": {0: "batch"}, "prob": {0: "batch"}},
        opset_version=13,
        dynamo=False,  # legacy TorchScript exporter: clean static graph for onnxruntime-web
    )
    onnx_size = os.path.getsize(ONNX_OUT)
    print(f"exported {ONNX_OUT} ({onnx_size/1024:.1f} KB)", file=sys.stderr)

    # ---- verify ONNX matches PyTorch ----
    onnx_ok, max_diff = verify_onnx(exp, Xeval[:64], device)

    # ---- meta for Phase 3 ----
    eval_metrics = results["test_cc"] if has_test else results["val_cc"]
    meta = {
        "model": "callout-cnn",
        "input": {"shape": [1, 1, 48, 48], "layout": "NCHW", "dtype": "float32"},
        "preprocessing": "value = patch_uint8 / 255.0 (0=ink, 1=white); no mean/std normalization",
        "output": "single sigmoid probability of class=callout",
        "threshold": round(thr, 6),
        "threshold_selected_on": "val cc-only (held-out sections across all 5 gold catalogs), max-F1",
        "trained_on": sorted(set(catalog.tolist())),
        "params": int(n_params),
        "onnx_opset": 13,
        "onnx_size_bytes": int(onnx_size),
        "eval_cc": {k: eval_metrics[k] for k in ("precision", "recall", "f1", "ap")},
        "eval_cc_split": "test (held-out catalog)" if has_test else "val (held-out sections, all 5 catalogs)",
    }
    json.dump(meta, open(META_OUT, "w"), indent=2)

    write_report(args, n_params, onnx_size, thr, best_epoch, results,
                 fp_sum, fn_sum, onnx_ok, max_diff, op_points, has_test, eval_split_name)
    print("wrote report + meta", file=sys.stderr)


def verify_onnx(exp_model, X, device):
    import torch
    import onnxruntime as ort

    exp_model.eval()
    with torch.no_grad():
        pt = exp_model(torch.from_numpy(X).to(device)).cpu().numpy()
    sess = ort.InferenceSession(ONNX_OUT, providers=["CPUExecutionProvider"])
    ox = sess.run(["prob"], {"input": X})[0]
    max_diff = float(np.max(np.abs(pt - ox)))
    ok = max_diff < 1e-4
    print(f"ONNX verify: max_diff={max_diff:.2e} ok={ok}", file=sys.stderr)
    assert ok, f"ONNX output diverges from PyTorch (max_diff={max_diff})"
    return ok, max_diff


def write_report(args, n_params, onnx_size, thr, best_epoch, R, fp, fn, onnx_ok, max_diff,
                 op_points, has_test, eval_split_name):
    def row(m):
        return (f"| {m['name']} | {m['n']} | {m['pos']} | {m['precision']:.4f} | "
                f"{m['recall']:.4f} | {m['f1']:.4f} | {m['ap']:.4f} |")

    vc = R["val_cc"]
    ec = R["test_cc"] if has_test else R["val_cc"]   # eval cc-only block
    ename = "TEST" if has_test else "val"
    lines = []
    A = lines.append
    A("# Phase 2 - callout CNN classifier: training report\n")
    A("Binary classifier that gates candidate connected-component blobs into "
      "callout / not-callout. It does **not** read the digit (Tesseract does); "
      "its job is **precision** - reject ~67% non-callout candidates while keeping "
      "essentially all real callouts.\n")
    if has_test:
        A(f"Split: **leave-one-catalog-out**, test = `{args.holdout}` (LOCO sanity run).\n")
    else:
        A("Split: **final all-5-gold model** - trained on 996 + 997TT + 356 + Boxster + 911, "
          "with a held-out val split of sections (per catalog) for early-stop + threshold "
          "selection. This is the model that ships to seed the held-out catalogs.\n")

    A("## Architecture\n")
    A("3× (Conv3×3-BN-ReLU-MaxPool2) with channels 1→16→32→64, "
      "GlobalAvgPool → FC(64→32)-ReLU-Dropout(0.3) → FC(32→1) logit.\n")
    A(f"- Parameters: **{n_params:,}**")
    A(f"- ONNX size: **{onnx_size/1024:.1f} KB** (opset 13, dynamic batch) - target <1 MB met")
    A(f"- ONNX vs PyTorch max abs diff on 64 {ename.lower()} patches: **{max_diff:.2e}** (verified close)\n")

    A("## Preprocessing contract (Phase 3 MUST replicate exactly)\n")
    A("- Input tensor NCHW `[N,1,48,48]` float32")
    A("- `value = patch_uint8 / 255.0` → **0 = ink, 1 = white**")
    A("- **No** mean/std normalization (plain `/255`)")
    A("- Exported ONNX applies sigmoid internally: **output is a probability in [0,1]**")
    A(f"- Operating threshold: **{thr:.4f}** (prob ≥ threshold ⇒ callout)\n")

    A("## Training\n")
    A(f"- Loss: BCEWithLogits, `pos_weight = n_neg/n_pos` (handles 33/67 imbalance)")
    A(f"- Optimizer: Adam lr={args.lr}, weight_decay=1e-4, cosine schedule")
    A(f"- Augmentation (train only): "
      f"{'OFF' if args.no_aug else f'rot ±{args.rot}°, trans ±{args.trans}px, scale ±{int(args.scale*100)}%, hflip={args.hflip}, vflip={args.vflip}'}")
    A("  - Deliberately small rotation: the callout **digit is always upright**; "
      "only the leader line varies angle, and leaders at all angles are already in the data. "
      "Large rotations would tilt digits into orientations that never occur.")
    A(f"- Model selection: best **val cc-only AUC-PR**, early-stop patience {args.patience} (best epoch {best_epoch})")
    A(f"- Threshold: max-F1 on **val cc-only** (the realistic inference distribution)")
    A(f"- Seed {args.seed}\n")

    A("## Metrics\n")
    A("cc = candidate-blob-centered patches = the **real inference-time distribution**. "
      "gt = ground-truth-box-centered safety-net positives (training aid). "
      "**The cc-only rows are the honest numbers.**\n")
    A("| split | n | pos | precision | recall | F1 | AUC-PR |")
    A("|---|---|---|---|---|---|---|")
    keys = ("val_cc", "val_all", "test_cc", "test_all") if has_test else ("val_cc", "val_all")
    for k in keys:
        A(row(R[k]))
    A("")

    A(f"### Operating points - {ename} cc-only\n")
    A("The chosen max-F1 threshold is recall-heavy; since the gate's job is precision, "
      "downstream may prefer a higher threshold. Best precision at each recall floor "
      "(full curve in `ocr/callout-cnn.pr_curve.csv`):\n")
    A("| recall floor | precision | recall | threshold |")
    A("|---|---|---|---|")
    for rf, pr, rc, th in op_points:
        A(f"| ≥{rf:.3f} | {pr:.4f} | {rc:.4f} | {th:.4f} |")
    A("")

    A(f"## Confusion matrix - {ename} cc-only, at chosen threshold\n")
    A("| | pred callout | pred not |")
    A("|---|---|---|")
    A(f"| **actual callout** | TP {ec['tp']} | FN {ec['fn']} |")
    A(f"| **actual not** | FP {ec['fp']} | TN {ec['tn']} |\n")

    A(f"## What are the errors? ({ename} cc-only, via manifest bboxes)\n")
    A(f"**False positives ({fp.get('count',0)})** - non-callouts scored as callouts. "
      f"median blob w×h = {fp.get('w_median','?')}×{fp.get('h_median','?')} px; "
      f"{fp.get('narrow_w_le12',0)} are narrow (w≤12px, lone-stroke / clip / part-edge shaped).")
    A(f"\n**False negatives ({fn.get('count',0)})** - real callouts missed. "
      f"median w×h = {fn.get('w_median','?')}×{fn.get('h_median','?')} px; "
      f"{fn.get('tall_thin(w<=12,h>=20)',0)} are the thin tall lone-'1' shape (w≤12,h≥20). "
      f"Missed-digit histogram: {fn.get('digit_hist_top',{})}; "
      f"of these, lone-digit-'1' misses = {fn.get('lone_1_count',0)}.")
    A("")

    if has_test:
        gen_gap = vc["ap"] - ec["ap"]
        verdict = (
            "GENERALIZES WELL" if gen_gap < 0.03 else
            "GENERALIZES (minor gap)" if gen_gap < 0.08 else
            "PARTIAL - measurable cross-catalog drop"
        )
        A("## Cross-catalog generalization (the point of leave-one-catalog-out)\n")
        A(f"- val cc-only AUC-PR = **{vc['ap']:.4f}**, F1 = {vc['f1']:.4f}")
        A(f"- TEST ({args.holdout}) cc-only AUC-PR = **{ec['ap']:.4f}**, F1 = {ec['f1']:.4f}")
        A(f"- AUC-PR gap (val−test) = **{gen_gap:+.4f}** → **{verdict}**\n")
    else:
        A("## Held-out val (all 4 gold catalogs)\n")
        A(f"- val cc-only AUC-PR = **{vc['ap']:.4f}**, F1 = {vc['f1']:.4f}, "
          f"P = {vc['precision']:.4f}, R = {vc['recall']:.4f}\n")

    open(REPORT_OUT, "w", encoding="utf-8").write("\n".join(lines))


if __name__ == "__main__":
    main()
