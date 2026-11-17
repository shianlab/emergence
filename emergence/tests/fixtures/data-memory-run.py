"""Measure the interpreter running the worker, not Windows venv's redirector."""

import ctypes
import json
import os
import runpy
import sys


class Counters(ctypes.Structure):
    _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong)] + [
        (k, ctypes.c_size_t)
        for k in [
            "PeakWorkingSetSize",
            "WorkingSetSize",
            "QuotaPeakPagedPoolUsage",
            "QuotaPagedPoolUsage",
            "QuotaPeakNonPagedPoolUsage",
            "QuotaNonPagedPoolUsage",
            "PagefileUsage",
            "PeakPagefileUsage",
        ]
    ]


try:
    runpy.run_path(sys.argv[1], run_name="__main__")
finally:
    kernel = ctypes.WinDLL("kernel32")
    psapi = ctypes.WinDLL("psapi")
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    psapi.GetProcessMemoryInfo.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(Counters),
        ctypes.c_ulong,
    ]
    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    available = psapi.GetProcessMemoryInfo(
        kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb
    )
    print(
        "WORKER_MEMORY:"
        + json.dumps(
            {"pid": os.getpid(), "peak": counters.PeakWorkingSetSize if available else None}
        ),
        file=sys.stderr,
    )
