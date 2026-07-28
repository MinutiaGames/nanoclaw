# LM Studio model-loading issue — root cause found (Windows-side investigation)

**Status: root-caused and mitigated (2026-07-27), see below.** This was
originally written as an open handoff for a fresh Claude session on the
Windows side; the investigation is now closed for the main symptom. This
doc is kept as a record of what was tried and what the actual cause turned
out to be, in case related symptoms resurface.

## The original symptom

- Loading a model in LM Studio increasingly failed with a load error, even
  for small models (~1GB, quantized, configured to fit entirely on GPU).
- Workarounds that appeared to clear it: reducing context length/GPU
  offload before loading, or fully restarting LM Studio.
- Appeared to recur after normal use — specifically after loading/unloading
  a sequence of different models.
- Separately, a server connection was observed dropping mid-request
  (`"terminated"` error) while a model was actively running.

## Environment

- **LM Studio runs natively on Windows**, not inside WSL. Reachable from
  the WSL/Linux side at `192.168.1.151:1234` (a real LAN IP), which is how
  the rest of this project (WSL2 + Docker containers) talks to it via its
  OpenAI-compatible `/v1/...` API.
- GPU: **AMD Radeon RX 5700 XT** (Vulkan backend — this is an AMD card, so
  no CUDA path is available; llama.cpp runs via `llama.cpp-win-x86_64-vulkan-avx2`
  on top of AMD's proprietary Vulkan driver, `amdvlk64.dll`).

## Root cause: AMDVLK's ~2GiB single-allocation ceiling

Confirmed via Windows Event Viewer (`Get-WinEvent -FilterHashtable
@{LogName='Application'; ProviderName='Application Error'}`): LM Studio's
`llama-server.exe` was crashing with `exitCode=3221225477`
(`0xC0000005`/`STATUS_ACCESS_VIOLATION`) during model load, at a
consistent ~38% mark through the load progress. Critically, the event log
also showed **Ollama's own bundled `llama-server.exe`** (a completely
separate application) crashing with the identical exception, at the
identical fault offset, inside the identical module —
`amdvlk64.dll` (AMD's proprietary Vulkan driver). That rules out an
LM Studio bug, a specific-model/architecture bug, or an engine-version
regression: two unrelated llama.cpp-based apps are both crashing inside
AMD's own Vulkan driver code.

This matches a known upstream issue:
[ggml-org/llama.cpp#15054](https://github.com/ggml-org/llama.cpp/issues/15054)
— **AMDVLK enforces a hard ~2 GiB limit on any single Vulkan memory
allocation** (`maxMemoryAllocationSize = 0x80000000`), and rejects/crashes
on anything larger with `VK_ERROR_OUT_OF_DEVICE_MEMORY`, regardless of how
much total VRAM is free. RADV (the open-source Linux Mesa driver) does not
have this limit — but RADV isn't available on native Windows, so this
isn't a driver-swap fix here.

At high context length (32k) and GPU offload, llama.cpp's Vulkan backend
apparently needs a single buffer allocation that lands close to or over
that ~2GiB ceiling — hence the "intermittent" nature: whether a given load
crashes depends on transient VRAM fragmentation/contention at that exact
moment (other GPU consumers, driver state), not on anything deterministic
in LM Studio's config. This also explains why reducing context length or
restarting LM Studio "worked" as an inconsistent workaround before: both
happen to shrink or reset the size of that buffer allocation, not because
of a VRAM leak.

**This was not a VRAM leak across model swaps** (the original working
hypothesis in this doc) — a completely fresh LM Studio process, on its
very first load attempt after a clean restart, hits the same crash at the
same rate.

## A separate, real bug also found and fixed: stale KV-cache config

Independent of the driver issue, `google/gemma-4-12b-qat`'s saved
per-model config
(`~/.lmstudio/.internal/user-concrete-model-default-config/google/gemma-4-12b-qat.json`)
had K/V cache quantization (`q4_0`) enabled without flash attention, left
over from an earlier VRAM-tuning experiment. LM Studio's CPU backend
correctly rejects this combination
(`V Cache Quantization requires flash attention to be enabled`); the
Vulkan backend did not validate it and crashed instead (a separate crash
signature from the AMDVLK one, but was masking/compounding it). Fixed by
enabling `q8_0` K/V cache quantization together with flash attention —
this is also a mitigation for the AMDVLK ceiling, since quantizing the
cache shrinks the buffer size.

## What actually fixes vs. mitigates it

- **Real fix for the config bug**: enable flash attention whenever K/V
  cache quantization is enabled. Done for `gemma-4-12b-qat`.
- **No real fix for the AMDVLK ceiling** — it's an external driver bug,
  not something LM Studio, this project, or a config change can close
  outright. Lowering context length/quantizing the cache reduces the
  *probability* of a crash (smaller buffer, more headroom under 2GiB) but
  does not eliminate it at context lengths/offloads actually needed for
  real use (measured ~20% failure rate per load attempt at 32k context +
  offload=24, even with quantized cache enabled).
- **Practical mitigation shipped**: `scripts/lmstudio-reset.ps1`'s
  `-Model` auto-load step now retries the `lms load` call up to 20 times
  on failure before giving up. A crashed attempt fails fast (a few
  seconds), and once a load succeeds it's stable afterward — the crash
  only happens during the initial GPU buffer allocation — so retrying is
  safe and, empirically, reliable within a handful of attempts.

## Separate finding: closing the launcher PowerShell window killed LM Studio

Unrelated to the above: running the reset script directly in the same
PowerShell window Claude Code was using caused prompt output to overlap.
Running it via `Start-Process powershell.exe -ArgumentList '-NoExit',
'-File', ...` in a new window fixed the overlap, but closing that new
window then also killed LM Studio — because Windows Terminal kills the
entire descendant process tree of a pane/tab when it closes, including
grandchild GUI processes. Fixed in the script itself: LM Studio is now
launched via `Start-Process -FilePath 'explorer.exe' -ArgumentList
"<path>"` instead of directly, since explorer.exe proxies the launch
through the already-running Explorer shell process — which sits outside
the calling terminal's process tree/job object — so LM Studio survives the
launcher window closing.

## If related symptoms resurface

- The mid-request `"terminated"` connection drop (see original live data
  point below) was not re-investigated in this session — it may or may not
  share the same root cause. Worth checking Windows Event Viewer the same
  way (`Application Error` provider, filter for `llama-server.exe` or
  `amdvlk64.dll`) if it recurs.
- If AMD ships a driver update, worth re-testing whether the ~2GiB ceiling
  is fixed upstream — check `Get-CimInstance Win32_VideoController` for
  the current `DriverVersion` against AMD's release notes.

---

### Original live data point (2026-07-25/26, kept for reference)

While testing `google/gemma-4-12b-qat` from the WSL/Linux side, one
request failed with a bare `"terminated"` error after a ~370s hang on
LM Studio's `/v1/chat/completions`-equivalent endpoint — read at the time
as the backend server process dying/restarting mid-request. Given the
AMDVLK finding above, this is plausibly the same class of driver-level
crash rather than an application-level bug, but wasn't specifically
confirmed against the Event Viewer log for that exact timestamp.

### What was ruled out earlier (still valid)

- **Not a WSL/Docker memory problem** — WSL was using ~1.9GB/19GB, Docker
  containers ~560MB total combined; nothing runaway.
- **Docker disk bloat was real but unrelated** — ~10.75GB of images/build
  cache cleared via `docker system prune -a -f`, but the load failures
  predated this cleanup and are on the Windows side regardless.
- **Windows `vmmem` elevation** is WSL2's normal behavior of not returning
  freed memory without `wsl --shutdown` — a separate phenomenon from
  LM Studio's native-Windows-process crashes.

### Context: why this mattered

NanoClaw is mid-way through a local-model bake-off — testing small/local
models via LM Studio for reliability on an agentic tool-use task, aiming
to find one cheap enough to run as a "sub-agent" model alongside a larger
orchestrator model.
