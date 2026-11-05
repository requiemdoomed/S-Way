# models/

S-Way's trusted model registry.

- `calibration.json` — decision thresholds and handwriting variability scales fitted by the research notebooks (`notebooks/01`–`05`). Contains evaluation metrics for transparency.
- `model_manifest.json` — lists every artifact the app may load and its SHA-256 digest. `neural_models` is empty: S-Way ships no neural networks.

At start-up the browser fetches both files from the same origin, verifies the digest with Web Crypto and only then applies the values (numbers only, known keys only). On any mismatch or error it uses built-in defaults and the Privacy Center shows "Built-in defaults". Uploaded documents can never cause another file or URL to be loaded.

Regenerate after changing an engine: `python3 tools/build_notebooks.py` (re-executes all notebooks and rewrites both files). Then run `npm test` — a unit test checks the digest.
