"""CCITT Group 4 (ITU-T T.6) bilevel decoder - Python port of the decode half of
docs/ccitt.js. Diagrams are stored as raw T.6 bitstream (no header); width/height
ride alongside. Convention: white=0, black=1, MSB-first bit packing (FillOrder 1).

    decode(bytes, width, height) -> np.ndarray  # shape (H, W) uint8, 0/1
"""
import numpy as np

WHITE_TERM = [
    '00110101','000111','0111','1000','1011','1100','1110','1111',
    '10011','10100','00111','01000','001000','000011','110100','110101',
    '101010','101011','0100111','0001100','0001000','0010111','0000011','0000100',
    '0101000','0101011','0010011','0100100','0011000','00000010','00000011','00011010',
    '00011011','00010010','00010011','00010100','00010101','00010110','00010111','00101000',
    '00101001','00101010','00101011','00101100','00101101','00000100','00000101','00001010',
    '00001011','01010010','01010011','01010100','01010101','00100100','00100101','01011000',
    '01011001','01011010','01011011','01001010','01001011','00110010','00110011','00110100']

WHITE_MAKEUP = {
    64:'11011',128:'10010',192:'010111',256:'0110111',320:'00110110',384:'00110111',
    448:'01100100',512:'01100101',576:'01101000',640:'01100111',704:'011001100',768:'011001101',
    832:'011010010',896:'011010011',960:'011010100',1024:'011010101',1088:'011010110',1152:'011010111',
    1216:'011011000',1280:'011011001',1344:'011011010',1408:'011011011',1472:'010011000',1536:'010011001',
    1600:'010011010',1664:'011000',1728:'010011011'}

BLACK_TERM = [
    '0000110111','010','11','10','011','0011','0010','00011',
    '000101','000100','0000100','0000101','0000111','00000100','00000111','000011000',
    '0000010111','0000011000','0000001000','00001100111','00001101000','00001101100','00000110111','00000101000',
    '00000010111','00000011000','000011001010','000011001011','000011001100','000011001101','000001101000','000001101001',
    '000001101010','000001101011','000011010010','000011010011','000011010100','000011010101','000011010110','000011010111',
    '000001101100','000001101101','000011011010','000011011011','000001010100','000001010101','000001010110','000001010111',
    '000001100100','000001100101','000001010010','000001010011','000000100100','000000110111','000000111000','000000100111',
    '000000101000','000001011000','000001011001','000000101011','000000101100','000001011010','000001100110','000001100111']

BLACK_MAKEUP = {
    64:'0000001111',128:'000011001000',192:'000011001001',256:'000001011011',320:'000000110011',384:'000000110100',
    448:'000000110101',512:'0000001101100',576:'0000001101101',640:'0000001001010',704:'0000001001011',768:'0000001001100',
    832:'0000001001101',896:'0000001110010',960:'0000001110011',1024:'0000001110100',1088:'0000001110101',1152:'0000001110110',
    1216:'0000001110111',1280:'0000001010010',1344:'0000001010011',1408:'0000001010100',1472:'0000001010101',1536:'0000001011010',
    1600:'0000001011011',1664:'0000001100100',1728:'0000001100101'}

SHARED_MAKEUP = {
    1792:'00000001000',1856:'00000001100',1920:'00000001101',1984:'000000010010',2048:'000000010011',
    2112:'000000010100',2176:'000000010101',2240:'000000010110',2304:'000000010111',2368:'000000011100',
    2432:'000000011101',2496:'000000011110',2560:'000000011111'}

MODE = {'P':'0001','H':'001','V0':'1','VR1':'011','VR2':'000011','VR3':'0000011',
        'VL1':'010','VL2':'000010','VL3':'0000010'}


def _build_run_table(term, makeup):
    byLen = {}
    def add(s, val):
        byLen.setdefault(len(s), {})[int(s, 2)] = val
    for run, s in enumerate(term):
        add(s, run)
    for k, s in makeup.items():
        add(s, k)
    for k, s in SHARED_MAKEUP.items():
        add(s, k)
    return byLen


DECODE_RUN = [_build_run_table(WHITE_TERM, WHITE_MAKEUP),
              _build_run_table(BLACK_TERM, BLACK_MAKEUP)]


def _build_mode_table():
    byLen = {}
    for name, s in MODE.items():
        byLen.setdefault(len(s), {})[int(s, 2)] = name
    return byLen


DECODE_MODE = _build_mode_table()

_VDELTA = {'V0':0,'VR1':1,'VR2':2,'VR3':3,'VL1':-1,'VL2':-2,'VL3':-3}


class BitReader:
    __slots__ = ('b', 'pos', 'len')
    def __init__(self, b):
        self.b = b; self.pos = 0; self.len = len(b) * 8
    def read_bit(self):
        if self.pos >= self.len:
            return -1
        bit = (self.b[self.pos >> 3] >> (7 - (self.pos & 7))) & 1
        self.pos += 1
        return bit


def _read_code(br, table):
    acc = 0
    for L in range(1, 15):
        bit = br.read_bit()
        if bit < 0:
            return None
        acc = (acc << 1) | bit
        m = table.get(L)
        if m is not None and acc in m:
            return m[acc]
    return None


def _read_run(br, color):
    total = 0
    while True:
        v = _read_code(br, DECODE_RUN[color])
        if v is None:
            return None
        total += v
        if v < 64:
            return total


def _find_b1(changes, a0, color):
    i = 0
    while changes[i] <= a0:
        i += 1
    if (1 if (i & 1) == 0 else 0) == color:
        i += 1
    return i


def decode(data, width, height):
    """Returns np.ndarray shape (height, width), uint8 0=white/1=black."""
    br = BitReader(data)
    pixels = np.zeros((height, width), dtype=np.uint8)
    # Three width sentinels (JS uses two + undefined tolerance): findB1 can land on
    # the last sentinel, so b1i+1 must stay in range and read `width`.
    ref = [width, width, width]
    for y in range(height):
        cur = []
        a0 = -1; color = 0
        while a0 < width:
            mode = _read_code(br, DECODE_MODE)
            if mode is None:
                a0 = width; break
            b1i = _find_b1(ref, a0, color)
            b1 = ref[b1i]; b2 = ref[b1i + 1]
            if mode == 'P':
                a0 = b2
            elif mode == 'H':
                start = 0 if a0 < 0 else a0
                r1 = _read_run(br, color)
                r2 = _read_run(br, color ^ 1)
                if r1 is None or r2 is None:
                    a0 = width; break
                a1 = start + r1; a2 = a1 + r2
                if a1 < width:
                    cur.append(min(a1, width))
                if a2 < width:
                    cur.append(min(a2, width))
                a0 = a2
            else:
                a1 = b1 + _VDELTA[mode]
                if a1 < width:
                    cur.append(min(max(a1, 0), width))
                a0 = a1; color ^= 1
        # expand row changes into pixels
        x = 0; c = 0
        row = pixels[y]
        for t in cur:
            end = min(t, width)
            if c:
                row[x:end] = 1
            x = end; c ^= 1
        if c and x < width:
            row[x:width] = 1
        cur.append(width); cur.append(width); cur.append(width)
        ref = cur
    return pixels
