# LM Studio model-loading issue — handoff for Windows-side investigation

This is a narrow, standalone handoff about one specific problem: **LM Studio
increasingly fails to load models**, even small ones, and needs either a
setting reduction or a full restart to recover. It's written for a fresh
Claude session running *on the Windows side* (where LM Studio actually
runs), since the WSL/Linux side (where the rest of this project lives) has
no direct access to LM Studio's process, logs, or GPU driver state.

## The symptom

- Loading a model in LM Studio increasingly fails with a load error.
- This happens **even for small models** (~1GB, quantized, configured to
  fit entirely on GPU) — not just large ones.
- Workarounds that reliably clear it:
  - Reducing context length and/or GPU offload before loading, **or**
  - Fully restarting the LM Studio application.
- It recurs after normal use — specifically after loading/unloading a
  sequence of different models (this project has been swapping models in
  LM Studio repeatedly over a long session, roughly a dozen swaps across
  several hours).

## Environment

- **LM Studio runs natively on Windows**, not inside WSL. It's reachable
  from the WSL/Linux side at `192.168.1.151:1234` (a real LAN IP, not a
  Docker-internal address), which is also how the rest of this project
  (running in WSL2 + Docker containers) talks to it via its
  OpenAI-compatible `/v1/...` API.
- The Linux/WSL side is Ubuntu-24.04 under WSL2, running Docker Desktop
  (which itself uses separate `docker-desktop`/`docker-desktop-data` WSL
  distros).
- GPU: models are being loaded with high GPU offload ratios (e.g. 24/26,
  32/48 layers depending on model) — offload is not the suspected cause
  itself, since even models sized to fit entirely on GPU still hit this.

## What's already been ruled out (from the WSL/Linux side — don't re-check these)

- **Not a WSL/Docker memory problem.** Checked live: WSL itself was using
  only ~1.9GB of 19GB available; all Docker containers combined (a test
  agent container, plus two unrelated always-on services) were using
  ~560MB total. Nothing runaway there.
- **Docker disk bloat was real but is a different issue.** Docker had
  accumulated ~10.75GB of images (7.4GB unused) and ~5.4GB of build cache
  from this session's repeated container rebuild/test cycles — cleared via
  `docker system prune -a -f` (reclaimed ~10.34GB). This may have modestly
  helped overall system memory pressure, but it's WSL-side disk bloat, not
  a fix for LM Studio's own load failures, and the load failures were
  already happening before this cleanup.
- **Windows Task Manager's `vmmem`** (WSL2's shared VM, covering all WSL
  distros combined including Docker Desktop's) was elevated. This is at
  least partly explained by WSL2's well-known behavior of not proactively
  returning freed memory to Windows without an explicit `wsl --shutdown` —
  but that's a separate phenomenon from LM Studio's own load failures,
  since LM Studio is a native Windows process, not something running
  inside WSL2's VM.

## Working hypothesis (not confirmed — needs Windows-side verification)

The recover-via-restart behavior strongly suggests **GPU VRAM not being
fully released between LM Studio's own model unload/load cycles** —
either genuine fragmentation (llama.cpp/ggml's GPU allocators are
generally worse at defragmentation than CPU allocators) or an actual
leak-like accumulation across swaps in LM Studio's backend process. Also
worth checking: LM Studio typically preallocates the KV cache sized to
the *configured context length*, not the model's parameter count — so
even a tiny model can still demand a large contiguous VRAM allocation if
context length is left high, which would explain "small model still
fails" if there's any fragmentation/leftover allocation from a prior
model's session.

## Suggested next steps for the Windows-side investigation

1. Check actual GPU memory (not just system RAM) via Task Manager's GPU
   tab or `nvidia-smi`, both right after a failed load attempt and right
   after a full LM Studio restart, to see if VRAM is genuinely not being
   released between the two states.
2. Check LM Studio's own logs (Settings → Developer / the app's log file)
   for the specific error text on a failed load — the exact error may
   point at "not enough VRAM" vs. some other failure class.
3. Check LM Studio's version and whether there's a newer release —
   VRAM-release-on-unload bugs in llama.cpp-based backends are a known,
   actively-fixed class of issue upstream.
4. Check whether the failure correlates with the *number* of models
   swapped since the last full restart (i.e. does it get more likely the
   more swaps happen), which would support the fragmentation/leak theory
   over a one-off bad load.
5. If reproducible, try disabling GPU offload entirely for one load to see
   if the failure is CPU-RAM-side instead of GPU-VRAM-side — would help
   narrow down which allocator is actually the problem.

## Context: why this matters right now

This project (NanoClaw, a personal-assistant framework) is mid-way through
a local-model bake-off — testing many different small/local models via LM
Studio for reliability on an agentic tool-use task, with the goal of
eventually finding one cheap enough to run as a "sub-agent" model
alongside a larger orchestrator model. The recurring load failures are
slowing down that testing loop (each failure requires reducing settings or
restarting LM Studio before the next model swap can proceed), but they are
not otherwise blocking — this doc exists so that investigation can happen
in parallel on the Windows side without re-deriving the WSL-side
diagnostics above from scratch.
