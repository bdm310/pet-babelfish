Be terse. Don't use more words when fewer will do.

Our goal is to build a system for downloading, ingesting, analyzing, and displaying the information contained in Porsche parts catalogs.

Things the user will want to do:
1. View the parts catalog filtered to a specific vehicle, vehicle+options, options alone, or any other partial or complete filter.
2. Quickly see what a part looks like and it's position in diagram views.
3. Search by name or part number
4. ???

These catalogs can be found as PDFs published by Porsche and may get supplemented by VIN decoding or manual entry of specific vehicle options. We won't distribute PDFs due to copyright concerns but we will build in automatic fetch from some existing sources. The catalog format is consistent across model lines. Most data is in real text in the PDF, with only the parts diagrams being images. Those diagrams do have cross-reference numbers in them which will need to be identified and extracted.

We need to ingest these catalogs and build our own data model from them in order to facilitate the kinds of manipulation and view the user will get at the end.

We'll use the simplest tools we can for each part. Everything will run local to the user's computer (outside of web fetches for data) and the UI should be a simple local hosted application.

There's two distinct portions of the project, separated by a clean interface. The first is ingesting and converting data to our model, which produces some output artifact(s) like data tables, part images, and diagrams. The second is the application which takes in those artifacts and allows the user to do their desired actions. These parts could share a single user interface or be entirely separate.