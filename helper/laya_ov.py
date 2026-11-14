#!/usr/bin/env python3
"""OpenVINO path for laya's frozen reader (Qwen3.5-0.8B).

What live /workflow computes: vegaml tokenises the prompt, runs the frozen causal LM up to layer 19, mean-pools the
hidden states at layers 13 and 19 over the state / question / last-token spans (and over each option's span), then a
numpy head (PCA + logistic) turns the pooled vector into probabilities. Only the LM + pooling is heavy, so only that
is exported: ids [1, L] and a pooling matrix [R, L] in, pooled rows [layers, R, d] out. The model is causal, so the
right padding up to the static L never changes an earlier token (gated-delta recurrence and conv included) and no
attention mask is needed.

  laya_ov.py export [--max-len N]   torch -> IR in ~/.cache/hub-dashboard/ov_model/ (run it capped, see ensure_export)
  laya_ov.py select                  compile on npu / gpu / cpu-ov, check parity, time them, write choice.json
  laya_ov.py status                  which hash / device is current

Run `export` and `select` through ensure_export() / run_capped(): each is a heavy process of its own.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "hub-dashboard"
OV_DIR = CACHE / "ov_model"
OV_CACHE = CACHE / "ov_cache"
VERSION = 1
KMAX = 12                      # option rows in the pooling matrix; a question with more options runs on torch
DEFAULT_MAX_LEN = 384          # real prompts are 178-346 tokens (options + instructions are ~120 of them)
DEVICES = {"npu": "NPU", "gpu": "GPU", "cpu-ov": "CPU"}
NAMES = tuple(DEVICES) + ("cpu",)
VENV_PY = Path.home() / ".local/share/hub-dashboard/laya-venv/bin/python"
MEM_MAX = os.environ.get("LAYA_OV_MEMMAX", "10G")


def backbone_path():
    from huggingface_hub import snapshot_download
    return snapshot_download("Qwen/Qwen3.5-0.8B", local_files_only=True)


def model_hash(path, max_len, feature_layers, option_layers):
    """Identity of what the IR was built from: the reader's weight files and config, the layers read, the shape."""
    h = hashlib.sha256()
    p = Path(path)
    for f in sorted(p.glob("*.safetensors")) + [p / "config.json"]:
        h.update(f.name.encode())
        h.update(str(f.resolve().stat().st_size).encode())
    h.update((p / "config.json").read_bytes())
    h.update(json.dumps([VERSION, max_len, KMAX, list(feature_layers), list(option_layers)]).encode())
    return h.hexdigest()


def read_meta(d=OV_DIR):
    try:
        return json.loads((Path(d) / "meta.json").read_text())
    except (OSError, ValueError):
        return None


def clip_item(it, max_len):
    """The prompt `it` ({"ids", "spans"}) cut to max_len tokens by dropping the OLDEST state tokens (the state span's
    head; the newest event and the question/options stay). Never loads torch; returns `it` itself when it fits."""
    n = len(it["ids"])
    if n <= max_len:
        return it
    s0, s1 = it["spans"]["state"]
    cut = min(n - max_len, max(0, s1 - s0 - 1))
    ids = list(it["ids"][:s0]) + list(it["ids"][s0 + cut:])
    sp = {"state": (s0, s1 - cut), "question": tuple(x - cut for x in it["spans"]["question"]),
          "options": [(a - cut, b - cut) for a, b in it["spans"]["options"]]}
    try:
        import numpy as np
        ids = np.asarray(ids, dtype=it["ids"].dtype)
    except Exception:
        pass
    if len(ids) > max_len:      # options + instructions alone over the limit: keep the head, drop the tail end
        ids = ids[:max_len]
    return {**it, "ids": ids, "spans": sp}


_TOK = None


def tokenizer():
    global _TOK
    if _TOK is None:
        from transformers import AutoTokenizer
        _TOK = AutoTokenizer.from_pretrained(backbone_path())
    return _TOK


def state_budget(tok, qs, max_len, margin=16):
    """Tokens the state may take: max_len minus the largest question prompt (header, instructions, options) with an
    empty state, minus a margin for the paraphrase template and option reordering."""
    from vegaml._api import Vega
    from vegaml._common import build_prompt
    fixed = 0
    for q in [Vega._internal(v) for v in (qs.values() if isinstance(qs, dict) else qs)]:
        ids, _ = build_prompt(tok, "", q, 10 ** 6)
        fixed = max(fixed, len(ids))
    return max(16, max_len - fixed - margin)


def pool_matrix(n, spans, max_len):
    """[3 + KMAX, max_len] float32: rows state / question / last token / options, each a mean over its span
    (exactly vegaml's segment means); unused rows are zero."""
    import numpy as np
    m = np.zeros((3 + KMAX, max_len), dtype=np.float32)
    a, b = spans["state"]; m[0, a:b] = 1.0 / max(1, b - a)
    a, b = spans["question"]; m[1, a:b] = 1.0 / max(1, b - a)
    m[2, n - 1] = 1.0
    for k, (a, b) in enumerate(spans["options"]):
        m[3 + k, a:b] = 1.0 / max(1, b - a)
    return m


# ----------------------------------------------------------------------------------------------- export
def _reader_module(path, feature_layers, option_layers):
    import torch
    from transformers import AutoConfig, AutoModelForCausalLM
    import torch.nn.functional as F
    import transformers.models.qwen3_5.modeling_qwen3_5 as mq

    def conv_static(hidden_states, weight, bias=None, activation=None, **kw):
        # transformers reads the kernel width off weight.shape, which tracing turns into a tensor (padding=[])
        out = F.conv1d(hidden_states.to(weight.dtype), weight.unsqueeze(1), bias, padding=3, groups=weight.shape[0])
        out = out[:, :, :hidden_states.shape[-1]]
        return F.silu(out) if activation == "silu" else out
    k = AutoConfig.from_pretrained(path).get_text_config().linear_conv_kernel_dim
    assert k == 4, k
    mq.causal_conv1d_fn = conv_static

    # OpenVINO has no conversion for linalg.solve_triangular: take transformers' own forward-substitution branch
    # (a (I+N)^-1 Neumann product was tried and overflows to NaN on real prompts)
    mq.is_torchdynamo_exporting = lambda: True
    import transformers.masking_utils as mu
    mu.find_packed_sequence_indices = lambda position_ids: None   # torch.diff has no OpenVINO conversion; no packing here
    lm = AutoModelForCausalLM.from_pretrained(path, dtype=torch.float32, attn_implementation="sdpa",
                                              low_cpu_mem_usage=True).eval()
    base = lm.model
    capture = sorted(set(feature_layers) | set(option_layers))
    base.layers = base.layers[:max(capture) + 1]        # nothing past the deepest layer we read
    base.norm = torch.nn.Identity()
    for p in lm.parameters():
        p.requires_grad_(False)
    del lm

    class Reader(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.base = base
            self.cap = {}
            for i in capture:
                base.layers[i].register_forward_hook(self._hook(i))

        def _hook(self, i):
            def hook(mod, inp, out):
                self.cap[i] = out[0] if isinstance(out, (tuple, list)) else out
            return hook

        def forward(self, ids, pool):
            self.cap = {}
            self.base(input_ids=ids, use_cache=False)
            return torch.stack([torch.matmul(pool, self.cap[i][0].float()) for i in capture])

    return Reader().eval(), capture


def reference_set(tok, max_len, n=30):
    """Token ids + pooling matrices for varied prompts built from the shipped benchmark states (no user data)."""
    import numpy as np
    bench = json.loads((HERE / "workflow_benchmark.json").read_text())
    texts = ["\n".join(c["state"]) if isinstance(c["state"], list) else str(c["state"]) for c in bench["cases"]]
    head = "Which move should come next? Options: frustration, harvest, canvas, nav, calc, none."
    out = []
    for i in range(n):
        t = texts[i % len(texts)]
        t = t[: max(40, len(t) * (3 + i // len(texts) * 2) // 10)] if i >= len(texts) else t
        s = tok(t, add_special_tokens=False)["input_ids"]
        q = tok(head, add_special_tokens=False)["input_ids"]
        pad = [tok.pad_token_id or 0] * 8
        ids = (s + q + pad)[:max_len - 1]
        ids = ids + [tok.pad_token_id or 0] * 0
        n_ids = len(ids)
        sp = {"state": (0, len(s)), "question": (len(s), min(len(s) + len(q), n_ids)),
              "options": [(min(len(s) + len(q), n_ids - 1), n_ids)]}
        full = np.full((1, max_len), tok.pad_token_id or 0, dtype=np.int64)
        full[0, :n_ids] = ids
        out.append((full, pool_matrix(n_ids, sp, max_len)))
    return out


def staticize(model, max_len=DEFAULT_MAX_LEN):
    """Rewrite every Reshape to a literal target shape. The traced graph reshapes through 0 / -1 patterns and
    ShapeOf-built Concats; the shapes are all static, but the NPU compiler rejects those forms."""
    import numpy as np
    import openvino as ov
    from openvino import opset13 as op
    model.reshape({model.inputs[0]: [1, max_len], model.inputs[1]: [3 + KMAX, max_len]})   # convert_model leaves [?, ?]
    model.validate_nodes_and_infer_types()
    n = 0
    for node in list(model.get_ordered_ops()):
        if node.get_type_name() != "Reshape":
            continue
        shape = node.get_output_partial_shape(0)
        if shape.is_dynamic:
            continue
        new = op.reshape(node.input_value(0), op.constant(np.array(list(shape.to_shape()), dtype=np.int64)), False)
        node.output(0).replace(new.output(0))
        n += 1
    model.validate_nodes_and_infer_types()
    return n


def export(max_len=DEFAULT_MAX_LEN, out_dir=OV_DIR):
    import gc
    import numpy as np
    import openvino as ov
    import torch
    from transformers import AutoTokenizer
    torch.set_num_threads(4)
    path = backbone_path()
    feature_layers, option_layers = [13, 19], [19]
    t0 = time.perf_counter()
    reader, capture = _reader_module(path, feature_layers, option_layers)
    tok = AutoTokenizer.from_pretrained(path)
    refs = reference_set(tok, max_len)
    ids0, pool0 = torch.from_numpy(refs[0][0]), torch.from_numpy(refs[0][1])
    with torch.inference_mode():
        want = np.stack([reader(torch.from_numpy(i), torch.from_numpy(p)).numpy() for i, p in refs])
        print(f"torch reference done {time.perf_counter() - t0:.0f}s", flush=True)
        ovm = ov.convert_model(reader, example_input=(ids0, pool0))
    print(f"converted {time.perf_counter() - t0:.0f}s; static reshapes: {staticize(ovm, max_len)}", flush=True)
    del reader, ids0, pool0
    gc.collect()
    out_dir = Path(out_dir)
    tmp = out_dir.with_name(out_dir.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True, mode=0o700)
    ov.save_model(ovm, str(tmp / "reader.xml"), compress_to_fp16=True)   # nncf is not installed: fp16 weights
    del ovm
    np.savez(tmp / "ref.npz", ids=np.stack([r[0] for r in refs]), pool=np.stack([r[1] for r in refs]), out=want)
    (tmp / "meta.json").write_text(json.dumps({
        "hash": model_hash(path, max_len, feature_layers, option_layers), "max_len": max_len, "kmax": KMAX,
        "feature_layers": feature_layers, "option_layers": option_layers, "capture": capture, "d": int(want.shape[-1]),
        "pad_id": tok.pad_token_id, "compression": "fp16", "version": VERSION, "path": path, "t": int(time.time())}))
    shutil.rmtree(out_dir, ignore_errors=True)
    tmp.rename(out_dir)
    shutil.rmtree(OV_CACHE, ignore_errors=True)       # blobs compiled from the old IR
    print(f"exported max_len={max_len} in {time.perf_counter() - t0:.0f}s -> {out_dir}", flush=True)


# ----------------------------------------------------------------------------------------------- runtime
class OVReader:
    """The compiled reader on one OpenVINO device. infer(ids, spans) -> float32 [n_capture, 3 + KMAX, d]."""

    def __init__(self, device, d=OV_DIR):
        import numpy as np
        import openvino as ov
        self.meta = read_meta(d)
        self.max_len = int(self.meta["max_len"])
        self.capture = list(self.meta["capture"])
        self.device = device
        self.lock = threading.Lock()
        OV_CACHE.mkdir(parents=True, exist_ok=True, mode=0o700)
        core = ov.Core()
        t = time.perf_counter()
        cfg = {"CACHE_DIR": str(OV_CACHE), "PERFORMANCE_HINT": "LATENCY", "NUM_STREAMS": 1}
        if device == "gpu":      # battery first: one request, f16, lowest queue priority/throttle, low host priority
            props = set(core.get_property("GPU", "SUPPORTED_PROPERTIES"))
            cfg.pop("NUM_STREAMS")
            for k, v in (("NUM_REQUESTS", 1), ("INFERENCE_PRECISION_HINT", "f16"), ("GPU_QUEUE_THROTTLE", "LOW"),
                         ("GPU_HOST_TASK_PRIORITY", "LOW"), ("GPU_QUEUE_PRIORITY", "LOW")):
                if k in props:
                    cfg[k] = v
        self.compiled = core.compile_model(str(Path(d) / "reader.xml"), DEVICES[device], cfg)
        self.compile_s = time.perf_counter() - t
        self.np = np
        self.pad = int(self.meta.get("pad_id") or 0)

    def run(self, ids_row, pool):
        ids = self.np.full((1, self.max_len), self.pad, dtype=self.np.int64)
        ids[0, :len(ids_row)] = ids_row
        with self.lock:
            return self.np.asarray(self.compiled([ids, pool])[0])


def _load_perception_class():
    from vegaml._common import Perception as Real

    class OVPerception(Real):
        """vegaml.Perception without the torch weights: pooled() runs the OpenVINO reader. Anything it can't do
        (a longer prompt, more than KMAX options, chunked long-state reads) is handed to the real torch model,
        loaded on first use."""

        def __init__(self, path, device, feature_layers, option_layers, quantize=None):
            from transformers import AutoConfig, AutoTokenizer
            from vegaml._common import resolve_layers
            self._args = (path, device, feature_layers, option_layers, quantize)
            self._real = None
            self._real_lock = threading.Lock()
            self.tok = AutoTokenizer.from_pretrained(path)
            n = AutoConfig.from_pretrained(path).get_text_config().num_hidden_layers
            self.device = device
            self.model = None
            self.n_layers = n
            self.feature_layers = resolve_layers(feature_layers, n)
            self.option_layers = resolve_layers(option_layers, n)
            self.capture = sorted(set(self.feature_layers) | set(self.option_layers))
            self.quantized = None
            self.ov = OV_READER
            self.ov_calls = 0
            if self.ov.capture != self.capture:
                raise RuntimeError("exported layers %s differ from the layers vegaml reads %s"
                                   % (self.ov.capture, self.capture))

        def _torch(self):
            with self._real_lock:
                if self._real is None:
                    print("laya-ov: WARNING: falling back to the torch reader (OpenVINO cannot take this request)", flush=True)
                    self._real = Real(*self._args)
            return self._real

        def pooled(self, items, chunks=0, chunk_min_tokens=2048, prefix_min=4096, chunk_tokens=128):
            # a long state is clipped to the static length (never a reason to load torch); torch is only for an
            # OpenVINO failure or a shape the compiled graph cannot take (more than KMAX options, chunked reads)
            items = [clip_item(it, self.ov.max_len) for it in items]
            ok = (not FAILED and not chunks and all(len(it["spans"]["options"]) <= KMAX for it in items))
            if not ok:
                return self._torch().pooled(items, chunks=chunks, chunk_min_tokens=chunk_min_tokens,
                                            prefix_min=prefix_min, chunk_tokens=chunk_tokens)
            try:
                return self._ov_pooled(items)
            except Exception as e:      # a device that dies mid-run: torch from here on, reported as cpu
                FAILED.append(f"{type(e).__name__}: {e}")
                print("laya-ov: WARNING: OpenVINO runtime failure, using torch:", FAILED[-1][:200], flush=True)
                return self._torch().pooled(items, chunks=chunks, chunk_min_tokens=chunk_min_tokens,
                                            prefix_min=prefix_min, chunk_tokens=chunk_tokens)

        def _ov_pooled(self, items):
            import numpy as np
            import torch
            fi = [self.ov.capture.index(i) for i in self.feature_layers]
            oi = [self.ov.capture.index(i) for i in self.option_layers]
            feats, opts = [], []
            for it in items:
                n = len(it["ids"])
                out = self.ov.run(np.asarray(it["ids"], dtype=np.int64), pool_matrix(n, it["spans"], self.ov.max_len))
                self.ov_calls += 1
                feats.append(torch.from_numpy(out[fi, :3, :].copy()))                                  # [Lf, 3, d]
                k = len(it["spans"]["options"])
                opts.append(torch.from_numpy(out[oi, 3:3 + k, :].transpose(1, 0, 2).copy()))          # [K, Lo, d]
            return torch.stack(feats, 0), torch.cat(opts, 0)

    return OVPerception


OV_READER = None
FAILED = []     # non-empty once the OpenVINO reader failed at run time


def choice(d=OV_DIR):
    """Device chosen by `select` for the current export, or None."""
    try:
        c = json.loads((Path(d) / "choice.json").read_text())
    except (OSError, ValueError):
        return None
    meta = read_meta(d)
    return c if meta and c.get("hash") == meta.get("hash") else None


def activate(want=None):
    """Called by the server before vegaml loads. Returns (device name, patch) or (None, reason).
    `want` is LAYA_INFER_DEVICE (npu|gpu|cpu-ov|cpu|auto)."""
    global OV_READER
    want = (want or "auto").strip().lower()
    if want == "cpu":
        return None, "forced cpu"
    meta = read_meta()
    if not meta or not (OV_DIR / "reader.xml").exists():
        return None, "no exported model"
    try:
        path = backbone_path()
        if meta.get("hash") != model_hash(path, meta["max_len"], meta["feature_layers"], meta["option_layers"]):
            return None, "export hash differs from the reader on disk"
        if want == "auto":
            c = choice()
            if not c or c.get("device") not in DEVICES:
                return None, "no passing device selected (run laya_ov.py select)"
            want = c["device"]
        if want not in DEVICES:
            return None, f"unknown device {want}"
        if want == "npu" and (os.environ.get("LAYA_INFER_DEVICE") or "").strip().lower() != "npu":
            return None, "npu is disabled unless LAYA_INFER_DEVICE=npu"
        OV_READER = OVReader(want)
        import vegaml._api as api
        api.Perception = _load_perception_class()
        return want, None
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


# ----------------------------------------------------------------------------------------------- select
def _bench(device, ref, n_time=30):
    import numpy as np
    r = OVReader(device)
    ids, pool, want = ref["ids"], ref["pool"], ref["out"]
    cos_min, rel_max, lat = 1.0, 0.0, []
    for i in range(len(ids)):
        n = int(np.nonzero(pool[i][2])[0][0]) + 1
        t = time.perf_counter()
        got = r.run(ids[i][0, :n], pool[i])
        lat.append((time.perf_counter() - t) * 1000)
        rows = [2] + [j for j in range(pool.shape[1]) if pool[i][j].any()]
        a, b = got[:, rows, :].reshape(-1, got.shape[-1]), want[i][:, rows, :].reshape(-1, got.shape[-1])
        cos = (a * b).sum(-1) / (np.linalg.norm(a, axis=-1) * np.linalg.norm(b, axis=-1) + 1e-12)
        cos_min = min(cos_min, float(cos.min()))
        rel_max = max(rel_max, float(np.abs(a - b).max() / (np.abs(b).max() + 1e-9)))
    lat1 = sorted(lat[1:])
    import resource
    return {"compile_s": round(r.compile_s, 2), "median_ms": round(lat1[len(lat1) // 2], 1), "cos_min": round(cos_min, 5),
            "rel_max": round(rel_max, 4), "rss_mb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024}


def bench_one(device):
    ref = dict(__import__("numpy").load(OV_DIR / "ref.npz"))
    print(json.dumps({"device": device, **_bench(device, ref)}), flush=True)


COS_OK, REL_OK = 0.995, 0.05


def select():
    """One capped child per device (a compile that dies must not take the others down), then write choice.json."""
    res = {}
    for dev in ("gpu", "cpu-ov"):    # the NPU compile never finished (19 min, 8.6 GB): only on LAYA_INFER_DEVICE=npu
        p = run_capped([sys.argv[0], "bench", dev], capture=True)
        line = [l for l in (p.stdout or "").splitlines() if l.startswith("{")]
        if p.returncode or not line:
            res[dev] = {"error": (p.stdout or "")[-300:].strip() or f"exit {p.returncode}"}
            continue
        r = json.loads(line[-1])
        r["ok"] = r["cos_min"] >= COS_OK and r["rel_max"] <= REL_OK
        res[dev] = r
    good = {d: r for d, r in res.items() if r.get("ok")}
    pick = None
    if good:
        fastest = min(r["median_ms"] for r in good.values())
        for d in ("gpu", "cpu-ov"):      # prefer the low-power device when within 20% of the fastest
            if d in good and good[d]["median_ms"] <= fastest * 1.2:
                pick = d
                break
    meta = read_meta() or {}
    (OV_DIR / "choice.json").write_text(json.dumps({"hash": meta.get("hash"), "device": pick, "results": res}, indent=1))
    print(json.dumps({"device": pick, "results": res}, indent=1))


# ----------------------------------------------------------------------------------------------- capped runs
def run_capped(args, capture=False, mem=MEM_MAX):
    """Run `laya_ov.py <args>` in its own process under a hard memory cap (systemd scope when available)."""
    py = str(VENV_PY if VENV_PY.exists() else sys.executable)
    cmd = [py, "-I", str(HERE / "laya_ov.py")] + list(args[1:])
    if shutil.which("systemd-run"):
        cmd = ["systemd-run", "--user", "--wait", "--pipe", "--collect", "--quiet", "-p", f"MemoryMax={mem}",
               "-p", "MemorySwapMax=0"] + cmd
    return subprocess.run(cmd, text=True, stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.STDOUT if capture else None)


def ensure_export(force=False):
    """Export (if the IR is missing or its hash no longer matches the reader) and select a device. True if the IR is
    usable afterwards. Called by train_workflow_cli.py after a fit; each step is its own capped process."""
    try:
        meta = read_meta()
        path = backbone_path()
        want = model_hash(path, (meta or {}).get("max_len", DEFAULT_MAX_LEN), [13, 19], [19])
        if force or not meta or meta.get("hash") != want or not (OV_DIR / "reader.xml").exists():
            print("laya-ov: exporting the reader to OpenVINO ...", flush=True)
            if run_capped([sys.argv[0], "export"]).returncode:
                print("laya-ov: export failed; the server keeps using torch", flush=True)
                return False
            changed = True
        else:
            changed = False
        if changed or not choice():
            run_capped([sys.argv[0], "select"])
        return True
    except Exception as e:
        print("laya-ov: skipped:", type(e).__name__, e, flush=True)
        return False


def main(argv):
    cmd = argv[0] if argv else "status"
    if cmd == "export":
        ml = int(argv[argv.index("--max-len") + 1]) if "--max-len" in argv else DEFAULT_MAX_LEN
        export(ml)
    elif cmd == "bench":
        bench_one(argv[1])
    elif cmd == "select":
        select()
    else:
        print(json.dumps({"meta": read_meta(), "choice": choice()}, indent=1, default=str))


if __name__ == "__main__":
    main(sys.argv[1:])
