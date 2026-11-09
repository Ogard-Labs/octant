import { useEffect, useMemo, useState } from "react";
import { createHostResourceClient } from "@octant/client-runtime/host-resource-client";
import type { HostResourceSnapshot } from "@octant/contracts/host-resources";
import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";
import { appendVitalsSample, formatBytes, formatRate, sparklinePoints } from "../shell/vitalsModel";
import { unavailable } from "./moduleState";

type Props = Pick<ThreadUtilityDockContentProps, "serverUrl" | "windowCapability">;

/** The host caches one snapshot for five seconds; asking faster only repeats it. */
const POLL_MS = 5_000;
const READ_TIMEOUT_MS = 5_000;

type VitalsState =
  | { readonly status: "waiting"; readonly history: ReadonlyArray<HostResourceSnapshot> }
  | { readonly status: "live"; readonly history: ReadonlyArray<HostResourceSnapshot> }
  | { readonly status: "refused" }
  | { readonly status: "unavailable"; readonly history: ReadonlyArray<HostResourceSnapshot> };

export default function VitalsModule(props: Props) {
  const { serverUrl, windowCapability } = props;
  const [state, setState] = useState<VitalsState>({ status: "waiting", history: [] });

  useEffect(() => {
    if (serverUrl === undefined) return undefined;
    const client = createHostResourceClient({
      baseUrl: serverUrl,
      fetch: globalThis.fetch,
      ...(windowCapability === undefined ? {} : { windowCapability }),
    });
    let stopped = false;
    let inflight: AbortController | undefined;
    const read = async () => {
      // Reads run only while the window is visible, one at a time, and a slow
      // one is abandoned so a stalled host cannot queue requests behind it.
      if (document.visibilityState === "hidden" || inflight !== undefined) return;
      const controller = new AbortController();
      inflight = controller;
      const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
      const result = await client.read(controller.signal);
      clearTimeout(timer);
      inflight = undefined;
      if (stopped) return;
      setState((current) => {
        const history = "history" in current ? current.history : [];
        if (result.status === "refused") return { status: "refused" };
        // A failed read drops the figures rather than showing old ones as current.
        if (result.status === "unavailable") return { status: "unavailable", history: [] };
        return { status: "live", history: appendVitalsSample(history, result.snapshot) };
      });
    };
    void read();
    const interval = setInterval(() => void read(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(interval);
      inflight?.abort();
    };
  }, [serverUrl, windowCapability]);

  if (serverUrl === undefined) return unavailable("Vitals", "No host is connected.");
  if (state.status === "refused") {
    return unavailable("Vitals", "This window may not read this host's load.");
  }
  if (state.status === "unavailable") {
    return unavailable("Vitals", "The host did not answer. Trying again.");
  }
  return <VitalsView history={state.history} />;
}

function VitalsView(props: { readonly history: ReadonlyArray<HostResourceSnapshot> }) {
  const latest = props.history[props.history.length - 1];
  const series = useMemo(() => {
    const pick = (value: (snapshot: HostResourceSnapshot) => number | undefined) =>
      props.history.map((snapshot) => value(snapshot) ?? 0);
    return {
      cpu: pick((s) => s.cpuPercent),
      memory: pick((s) => s.memory.usedBytes),
      netIn: pick((s) => s.network?.inBytesPerSecond),
      netOut: pick((s) => s.network?.outBytesPerSecond),
      diskIn: pick((s) => s.diskIo?.inBytesPerSecond),
      diskOut: pick((s) => s.diskIo?.outBytesPerSecond),
      gpu: pick((s) => s.gpu?.percent),
    };
  }, [props.history]);
  if (latest === undefined) {
    return (
      <section aria-label="Vitals" className="vitals" data-state="waiting">
        <p className="vitals__empty">Reading this host…</p>
      </section>
    );
  }
  const peak = (values: ReadonlyArray<number>) => Math.max(1, ...values);
  return (
    <section aria-label="Vitals" className="vitals">
      <VitalsTile
        label={`CPU · ${latest.cores} cores`}
        max={100}
        series={[series.cpu]}
        tall
        value={`${latest.cpuPercent}%`}
      />
      <VitalsTile
        label="Memory"
        max={latest.memory.totalBytes}
        series={[series.memory]}
        value={`${formatBytes(latest.memory.usedBytes)} / ${formatBytes(latest.memory.totalBytes)}`}
      />
      {latest.network === undefined ? null : (
        <VitalsTile
          label="Network"
          max={peak([...series.netIn, ...series.netOut])}
          series={[series.netIn, series.netOut]}
          value={`↓${formatRate(latest.network.inBytesPerSecond)} ↑${formatRate(latest.network.outBytesPerSecond)}`}
        />
      )}
      {latest.diskIo === undefined ? null : (
        <VitalsTile
          label="Disk I/O"
          max={peak([...series.diskIn, ...series.diskOut])}
          series={[series.diskIn, series.diskOut]}
          value={`R ${formatRate(latest.diskIo.inBytesPerSecond)} W ${formatRate(latest.diskIo.outBytesPerSecond)}`}
        />
      )}
      {latest.disk === undefined ? null : (
        <div className="vitals__tile">
          <div className="vitals__head">
            <span>Disk space</span>
            <span>
              {formatBytes(latest.disk.usedBytes)} used · {formatBytes(latest.disk.freeBytes)} free
            </span>
          </div>
          <meter
            aria-label="Disk space used"
            className="vitals__meter"
            max={Math.max(1, latest.disk.usedBytes + latest.disk.freeBytes)}
            value={latest.disk.usedBytes}
          />
        </div>
      )}
      {latest.gpu === undefined ? null : (
        <VitalsTile label="GPU" max={100} series={[series.gpu]} value={`${latest.gpu.percent}%`} />
      )}
      <div className="vitals__tile">
        <div className="vitals__head">
          <span>Energy</span>
          <span>
            {latest.energy === undefined
              ? "No battery"
              : `${latest.energy.batteryPercent}%${latest.energy.charging ? " · charging" : ""}`}
          </span>
        </div>
      </div>
    </section>
  );
}

function VitalsTile(props: {
  readonly label: string;
  readonly value: string;
  readonly max: number;
  readonly series: ReadonlyArray<ReadonlyArray<number>>;
  readonly tall?: boolean;
}) {
  const width = 240;
  const height = props.tall === true ? 72 : 36;
  return (
    <div className="vitals__tile">
      <div className="vitals__head">
        <span>{props.label}</span>
        <span>{props.value}</span>
      </div>
      <svg
        aria-hidden="true"
        className="vitals__chart"
        data-tall={props.tall === true ? "true" : undefined}
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} ${height}`}
      >
        {props.series.map((values, index) => (
          <polyline
            className="vitals__line"
            data-series={index}
            fill="none"
            key={index}
            points={sparklinePoints(values, props.max, width, height)}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    </div>
  );
}
