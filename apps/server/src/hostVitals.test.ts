import { describe, expect, it } from "vitest";
import {
  createHostVitalsSampler,
  parseIoregGpu,
  parseNetstatInterfaces,
  parseNvidiaSmiUtilization,
  parsePmsetBattery,
  parseProcDiskstats,
  parseProcNetDev,
} from "./hostVitals";

describe("host vitals", () => {
  it("sums non-loopback interface bytes from /proc/net/dev", () => {
    const text = [
      "Inter-|   Receive                            |  Transmit",
      " face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed",
      "    lo: 900 1 0 0 0 0 0 0 900 1 0 0 0 0 0 0",
      "  eth0: 1000 1 0 0 0 0 0 0 400 1 0 0 0 0 0 0",
      "  eth1: 50 1 0 0 0 0 0 0 20 1 0 0 0 0 0 0",
    ].join("\n");
    expect(parseProcNetDev(text)).toEqual({ inBytes: 1050, outBytes: 420 });
  });

  it("counts whole block devices once, not their partitions", () => {
    const text = [
      "   8 0 sda 10 0 100 0 5 0 40 0 0 0 0",
      "   8 1 sda1 9 0 90 0 5 0 40 0 0 0 0",
      " 259 0 nvme0n1 1 0 8 0 1 0 16 0 0 0 0",
      " 259 1 nvme0n1p1 1 0 8 0 1 0 16 0 0 0 0",
    ].join("\n");
    expect(parseProcDiskstats(text)).toEqual({ inBytes: 108 * 512, outBytes: 56 * 512 });
  });

  it("reads macOS interface, GPU and battery output", () => {
    const netstat = [
      "Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll",
      "lo0   16384 <Link#1>                          10     0       999       10     0        999     0",
      "en0   1500  <Link#4>    aa:bb:cc:dd:ee:ff     20     0      2000       30     0       3000     0",
      "en0   1500  192.168.1     192.168.1.5         20     -      2000       30     -       3000     -",
    ].join("\n");
    expect(parseNetstatInterfaces(netstat)).toEqual({ inBytes: 2000, outBytes: 3000 });
    expect(parseIoregGpu('"PerformanceStatistics" = {"Device Utilization %"=42}')).toEqual({
      percent: 42,
    });
    expect(parsePmsetBattery(" -InternalBattery-0 (id=1)\t80%; charging; 1:10 remaining")).toEqual({
      batteryPercent: 80,
      charging: true,
    });
    expect(parsePmsetBattery("Now drawing from 'AC Power'")).toBeUndefined();
  });

  it("reads the busiest NVIDIA GPU and ignores an error message", () => {
    expect(parseNvidiaSmiUtilization("12\n87\n")).toEqual({ percent: 87 });
    expect(parseNvidiaSmiUtilization("NVIDIA-SMI has failed")).toBeUndefined();
  });

  it("reports throughput only once two readings exist and ignores a reset counter", async () => {
    let clock = 0;
    const counters = [
      { inBytes: 1_000, outBytes: 0 },
      { inBytes: 3_000, outBytes: 500 },
      { inBytes: 10, outBytes: 0 },
    ];
    let reading = 0;
    const sample = createHostVitalsSampler(
      {
        network: async () => counters[reading++],
        diskIo: async () => undefined,
        gpu: async () => undefined,
        energy: async () => undefined,
      },
      () => clock,
    );
    expect((await sample()).network).toBeUndefined();
    clock = 2_000;
    expect((await sample()).network).toEqual({ inBytesPerSecond: 1_000, outBytesPerSecond: 250 });
    clock = 4_000;
    expect((await sample()).network).toBeUndefined();
  });
});
