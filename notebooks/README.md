# S-Way research notebooks

Executed Jupyter notebooks that develop, evaluate and calibrate S-Way's methods. They call the **shipped JavaScript engines** through `tools/sway-cli.mjs`, so every number describes the code the browser runs. They can also be read inside the app: *Research notebooks* in the navigation.

| Notebook | What it answers |
|---|---|
| `00_dataset_exploration` | What data is used, what it looks like, what its biases are |
| `01_text_similarity_benchmark` | How well do text measures detect inserted/paraphrased material; which thresholds? |
| `02_stylometry_evaluation` | When does style separate authors; supervised attribution; clustering |
| `03_handwriting_signature_synthetic` | Writer-disjoint handwriting evaluation, edge-hinge ablation, robustness; signature forgeries |
| `04_ocr_evaluation` | OCR error under scanning degradations; handwriting confidence |
| `06_preprocessing_and_tampering` | Perspective correction of phone photos; copy-move detection by paste size |
| `05_export_calibration` | Writes `models/calibration.json` and its SHA-256 manifest entry (runs last) |

## Run

```bash
pip install -r ../requirements.txt        # plus the Tesseract 5 binary (notebooks 04, 06)
python3 ../tools/build_notebooks.py       # build + execute all, rewrite calibration (~6 min)
python3 ../tools/build_notebooks.py 03_ 05_   # only selected notebooks
jupyter notebook                           # interactive
```

`sway_research.py` holds shared helpers: the JS bridge, corpus loading, rule-based paraphrasing, synthetic handwriting/signature generators, phone-photo and copy-move simulators, and metrics (AUC, EER, IoU, histogram similarity).

## Data

- `data/gutenberg/` — Project Gutenberg texts from the NLTK data repository (public domain).
- `data/generated/` — synthetic images produced on each run (git-ignored).
- No personal data. Real handwriting/signature datasets (IAM, CVL, CEDAR, GPDS) need licence agreements and were not used; results on synthetic images validate the pipeline, not real-world accuracy.
