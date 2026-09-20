# Vendored Simulator HID wire models

`DTUHIDModels.swift` and `XPCEncoder.swift` are copied **unmodified** from
<https://github.com/facebook/idb> at commit
`61f701bbac580c2051b105a34edd45edf11f8ce2`
(`FBSimulatorControl/HID/`), under the MIT license in `LICENSE`.

They describe the message shapes the Simulator's guest input daemon decodes
and how to serialize them to XPC. They depend on Foundation and XPC only.
Everything else in this helper is Octant's own code.

To update: replace both files from the same upstream directory, record the
new commit here, and run the device helper tests on a Mac with a booted
Simulator.
