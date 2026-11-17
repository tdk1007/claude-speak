"""Watch for an app starting to use the microphone (macOS 14.2+), then exit.

The speak mod runs this while it is reading aloud. Apps already recording when
it starts (a call, a voice chat) are the baseline and are ignored; the first
app that starts recording after that (dictation in Claude, macOS dictation,
Wispr Flow, Superwhisper, ...) makes it print `mic <pid> <bundle id>` and
exit 0, and the mod stops talking.

On macOS before 14.2 (no per-app list) it falls back to the default input
device: off -> on counts as a start.

    python mic_watch_mac.py           # watch (the mod's use)
    python mic_watch_mac.py --list    # print who is recording now and exit
"""
import ctypes
import ctypes.util
import struct
import sys
import time

CA = ctypes.CDLL("/System/Library/Frameworks/CoreAudio.framework/CoreAudio")
CF = ctypes.CDLL(ctypes.util.find_library("CoreFoundation"))


def fourcc(s: str) -> int:
    return struct.unpack(">I", s.encode())[0]


class Address(ctypes.Structure):
    _fields_ = [("selector", ctypes.c_uint32), ("scope", ctypes.c_uint32), ("element", ctypes.c_uint32)]


SYSTEM = 1
GLOBAL = fourcc("glob")
PROCESS_LIST = fourcc("prs#")
PROC_PID = fourcc("ppid")
PROC_BUNDLE = fourcc("pbid")
PROC_INPUT = fourcc("piri")
DEFAULT_INPUT = fourcc("dIn ")
RUNNING_SOMEWHERE = fourcc("gone")

CA.AudioObjectGetPropertyDataSize.argtypes = [ctypes.c_uint32, ctypes.POINTER(Address), ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
CA.AudioObjectGetPropertyData.argtypes = [ctypes.c_uint32, ctypes.POINTER(Address), ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
CF.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
CF.CFRelease.argtypes = [ctypes.c_void_p]


def get(obj: int, selector: int, ctype):
    addr = Address(selector, GLOBAL, 0)
    val = ctype()
    size = ctypes.c_uint32(ctypes.sizeof(val))
    if CA.AudioObjectGetPropertyData(obj, ctypes.byref(addr), 0, None, ctypes.byref(size), ctypes.byref(val)):
        return None
    return val.value


def processes():
    addr = Address(PROCESS_LIST, GLOBAL, 0)
    size = ctypes.c_uint32(0)
    if CA.AudioObjectGetPropertyDataSize(SYSTEM, ctypes.byref(addr), 0, None, ctypes.byref(size)):
        return None  # no per-app list on this macOS
    n = size.value // 4
    ids = (ctypes.c_uint32 * max(n, 1))()
    if CA.AudioObjectGetPropertyData(SYSTEM, ctypes.byref(addr), 0, None, ctypes.byref(size), ids):
        return None
    return list(ids[: size.value // 4])


def bundle(obj: int) -> str:
    ref = get(obj, PROC_BUNDLE, ctypes.c_void_p)
    if not ref:
        return "?"
    buf = ctypes.create_string_buffer(512)
    ok = CF.CFStringGetCString(ref, buf, 512, 0x08000100)  # UTF-8
    CF.CFRelease(ref)
    return buf.value.decode() if ok else "?"


def recording():
    """{pid: bundle id} of apps recording now, or None without a per-app list."""
    objs = processes()
    if objs is None:
        return None
    return {get(o, PROC_PID, ctypes.c_int32): bundle(o) for o in objs if get(o, PROC_INPUT, ctypes.c_uint32)}


# System listeners that hold the mic in the background ("Hey Siri" keeps
# CoreSpeech recording almost all the time): never a person starting dictation.
IGNORE = ("com.apple.CoreSpeech", "com.apple.corespeechd", "com.apple.voicetrigger", "com.apple.siri.", "com.apple.audio.")


def ignored(bid: str) -> bool:
    return bid.startswith(IGNORE)


def device_running() -> bool:
    dev = get(SYSTEM, DEFAULT_INPUT, ctypes.c_uint32)
    return bool(dev and get(dev, RUNNING_SOMEWHERE, ctypes.c_uint32))


def main():
    if "--list" in sys.argv:
        now = recording()
        print(now if now is not None else f"device running: {device_running()}")
        return
    deadline = time.time() + 30 * 60  # never outlive a reading by much
    base = recording()
    if base is None:
        was = device_running()
        while time.time() < deadline:
            time.sleep(0.2)
            now = device_running()
            if now and not was:
                print("mic device", flush=True)
                return
            was = now
        return
    print("watching " + " ".join(sorted(base.values())), flush=True)
    seen: dict = {}  # pid -> samples in a row it has been recording (two in a row counts)
    while time.time() < deadline:
        time.sleep(0.2)
        now = recording() or {}
        new = {p: b for p, b in now.items() if p not in base and not ignored(b)}
        seen = {p: seen.get(p, 0) + 1 for p in new}
        for pid, n in seen.items():
            if n >= 2:
                print(f"mic {pid} {new[pid]}", flush=True)
                return
        base = {p: b for p, b in base.items() if p in now}  # an app that stopped counts as new if it starts again


if __name__ == "__main__":
    main()
