"""Shared HTTP plumbing for the speak mod's voice services (macOS and Windows).

Each service loads one voice model once and serves it on 127.0.0.1:
  GET  /health  -> "ok" once the model is loaded and warmed up
  POST /tts     {"text", "out", ...} -> writes a WAV to `out`, answers "ok"
  POST /quit    -> exits (so the next start picks up a new voice sample)
It quits after `--idle` seconds without requests, so the model's memory is
handed back when nobody is listening. `out` must sit inside `--root` (the
mod's temp folder), so a local caller cannot make it write anywhere else.

Usage from a service:  serve(synth_fn)  where synth_fn(req: dict, out: str)
"""
import argparse
import json
import os
import socketserver
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler

# Keep the service logs readable: no download or generation progress bars.
for _k in ("TQDM_DISABLE", "HF_HUB_DISABLE_PROGRESS_BARS"):
    os.environ.setdefault(_k, "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")


def args():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--root", required=True, help="the only folder clips may be written to")
    p.add_argument("--idle", type=int, default=3600, help="seconds idle before quitting")
    p.add_argument("--ref", help="reference voice WAV (clone services)")
    p.add_argument("--ref-text", help="transcript of --ref (F5 needs it)")
    p.add_argument("--model", help="model to load (clone services)")
    p.add_argument("--steps", type=int, default=16, help="F5 sampling steps (16 is half the work of the default 32)")
    a = p.parse_args()
    a.root = os.path.realpath(a.root)
    return a


def lower_priority():
    """Below-normal CPU priority on Windows, so a game keeps the CPU first."""
    if sys.platform == "win32":
        import ctypes
        BELOW_NORMAL = 0x4000
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), BELOW_NORMAL)


def serve(opts, synth):
    lock = threading.Lock()
    state = {"last": time.time()}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def reply(self, code, body):
            data = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.reply(200 if self.path == "/health" else 404, "ok")

        def do_POST(self):
            state["last"] = time.time()
            if self.path == "/quit":  # the mod asks this after the voice sample changes
                self.reply(200, "bye")
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if self.path != "/tts":
                return self.reply(404, "no")
            try:
                req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                out = os.path.realpath(req["out"])
                if os.path.dirname(out) != opts.root:
                    return self.reply(403, "out must be in the speak temp folder")
                with lock:
                    synth(req, out)
                state["last"] = time.time()
                self.reply(200, "ok")
            except Exception as err:  # report, keep serving
                self.reply(500, f"{type(err).__name__}: {err}")

    class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
        daemon_threads = True
        allow_reuse_address = sys.platform != "win32"  # on Windows reuse would let two copies share the port

    server = Server(("127.0.0.1", opts.port), Handler)

    def idle_watch():
        while time.time() - state["last"] < opts.idle:
            time.sleep(15)
        server.shutdown()

    threading.Thread(target=idle_watch, daemon=True).start()
    print(f"serving on 127.0.0.1:{opts.port}", flush=True)
    server.serve_forever()
