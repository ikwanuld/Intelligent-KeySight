# ONNX Runtime Web 1.30.0 (WebAssembly build)

Runs the text models in `vendor/paddle/` on the phone. MIT licence, see
`LICENSE-onnxruntime.txt`. Files copied from the npm package
`onnxruntime-web@1.30.0` (`dist/`) with two small changes:

- `ort.wasm.min.mjs` and `ort-wasm-simd-threaded.mjs` are stored as
  `ort.wasm.min.js` and `ort-wasm-simd-threaded.js`. Their content is the
  same; some web hosts do not serve `.mjs` as JavaScript. The app tells the
  runtime where they are (`js/pallet/worker.js`).
- the source-map comment was removed from `ort.wasm.min.js`.

`ort-wasm-simd-threaded.wasm` is unchanged.
