# Hedgehog runtime assets

This directory holds the local Hedgehog community WASM runtime and FOX model.
The binary assets are intentionally ignored by Git and are installed with:

```sh
npm run hedgehog:install
```

The installer downloads the exact files listed in `manifest.json` and refuses
files whose SHA-256 checksum differs. Deploy these installed assets together
with the application; the server never downloads an engine or model at
runtime.

Before using or deploying the assets, review the
[Hedgehog community terms](https://hedgehog-bg.com/community). The public
source repository is MIT-licensed, while the distributed inference runtime and
models have additional community-use conditions.
