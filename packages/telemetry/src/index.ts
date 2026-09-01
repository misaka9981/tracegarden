import { randomUUID } from "node:crypto";

export type TelemetryScalar = string | number | boolean | null;
export type TelemetryAttributes = Readonly<Record<string, TelemetryScalar>>;

export type CorrelationMetadata = Readonly<{
  requestId: string;
  traceId: string;
  spanId: string;
}>;

export type StructuredLogSignal = Readonly<{
  kind: "log";
  level: "debug" | "info" | "warn" | "error";
  event: string;
  timestamp: string;
  correlation: CorrelationMetadata;
  attributes: TelemetryAttributes;
}>;

export type TraceSignal = Readonly<{
  kind: "trace";
  event: "span.start" | "span.end";
  name: string;
  timestamp: string;
  correlation: CorrelationMetadata;
  attributes: TelemetryAttributes;
}>;

export type MetricSignal = Readonly<{
  kind: "metric";
  name: string;
  type: "counter" | "gauge";
  value: number;
  timestamp: string;
  correlation: CorrelationMetadata;
  labels: Readonly<Record<string, string>>;
}>;

export type TelemetrySignal = StructuredLogSignal | TraceSignal | MetricSignal;
export type TelemetryExporter = (signal: TelemetrySignal) => void | Promise<void>;

export type TelemetryOptions = Readonly<{
  serviceName: string;
  logExporter?: TelemetryExporter;
  traceExporter?: TelemetryExporter;
  metricExporter?: TelemetryExporter;
  /** Test and local deterministic sinks. They are still best effort. */
  structuredLog?: (signal: StructuredLogSignal) => void | Promise<void>;
  trace?: (signal: TraceSignal) => void | Promise<void>;
  metric?: (signal: MetricSignal) => void | Promise<void>;
  now?: () => Date;
  requestId?: () => string;
}>;

const unsafeAttributeNames = new Set([
  "body", "content", "contents", "exception", "error", "exception_message", "log", "logs", "message", "note", "payload", "request_body", "response_body", "stack",
]);
const attributeName = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const metricName = /^[a-zA-Z_:][a-zA-Z0-9_:]{0,127}$/;
const labelName = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const MAX_LABEL_KEYS = 8;
const MAX_METRIC_SERIES = 1_000;

function unsafeName(value: string): boolean {
  const normalized = value.toLowerCase().replaceAll("-", "_");
  return unsafeAttributeNames.has(normalized)
    || /(?:body|content|payload|stack|exception)/.test(normalized)
    || normalized.includes("message")
    || normalized.includes("log");
}

function safeString(value: string): string {
  return value.length > 256 ? value.slice(0, 256) : value;
}

/** Keep telemetry metadata scalar and deliberately exclude protected content fields. */
export function safeTelemetryAttributes(input: Record<string, unknown> | undefined): TelemetryAttributes {
  if (!input) return {};
  const safe: Record<string, TelemetryScalar> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!attributeName.test(key) || unsafeName(key)) continue;
    if (typeof value === "string") safe[key] = safeString(value);
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === "boolean" || value === null) safe[key] = value;
  }
  return safe;
}

function safeLabels(input: Record<string, string> | undefined): Readonly<Record<string, string>> {
  if (!input) return {};
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(input).sort(([left], [right]) => left.localeCompare(right))) {
    if (Object.keys(labels).length >= MAX_LABEL_KEYS) break;
    if (typeof value !== "string" || !labelName.test(key) || unsafeName(key)) continue;
    labels[key] = safeString(value);
  }
  return labels;
}

function id(value: string | undefined, fallback: () => string): string {
  const candidate = value?.trim();
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) && !unsafeName(candidate) ? candidate : fallback();
}

function randomTraceId(): string {
  return randomUUID().replaceAll("-", "");
}

function randomSpanId(): string {
  return randomTraceId().slice(0, 16);
}

function labelsKey(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join(",");
}

function prometheusLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

export type TelemetrySpan = Readonly<{
  correlation: CorrelationMetadata;
  end: (attributes?: Record<string, unknown>) => void;
  fail: (error: unknown) => void;
}>;

type MetricValue = Readonly<{
  name: string;
  type: "counter" | "gauge";
  value: number;
  labels: Readonly<Record<string, string>>;
}>;

export class TelemetryRuntime {
  readonly serviceName: string;
  private readonly options: TelemetryOptions;
  private readonly createdAt: () => Date;
  private readonly counters = new Map<string, MetricValue>();
  private readonly gauges = new Map<string, MetricValue>();
  private readonly signalHistory: TelemetrySignal[] = [];

  constructor(options: TelemetryOptions) {
    if (!options.serviceName.trim()) throw new Error("Telemetry service name is required");
    this.serviceName = options.serviceName.trim();
    this.options = options;
    this.createdAt = options.now ?? (() => new Date());
  }

  correlation(requestId?: string): CorrelationMetadata {
    const request = id(requestId, this.options.requestId ?? (() => randomUUID()));
    return { requestId: request, traceId: randomTraceId(), spanId: randomSpanId() };
  }

  private dispatch(signal: TelemetrySignal): void {
    this.signalHistory.push(signal);
    if (this.signalHistory.length > 1_000) this.signalHistory.shift();
    const exporters: readonly (TelemetryExporter | undefined)[] = signal.kind === "log"
      ? [this.options.logExporter, this.options.structuredLog as TelemetryExporter | undefined]
      : signal.kind === "trace"
        ? [this.options.traceExporter, this.options.trace as TelemetryExporter | undefined]
        : [this.options.metricExporter, this.options.metric as TelemetryExporter | undefined];
    for (const exporter of exporters) {
      if (!exporter) continue;
      try {
        const result = exporter(signal);
        if (result && typeof (result as Promise<void>).catch === "function") void (result as Promise<void>).catch(() => undefined);
      } catch {
        // Exporters are optional. Their failure must never affect application work.
      }
    }
  }

  log(level: StructuredLogSignal["level"], event: string, correlation: CorrelationMetadata, attributes?: Record<string, unknown>): void {
    this.dispatch({
      kind: "log",
      level,
      event: safeString(event),
      timestamp: this.createdAt().toISOString(),
      correlation,
      attributes: safeTelemetryAttributes({ service: this.serviceName, ...attributes }),
    });
  }

  startSpan(name: string, correlation: CorrelationMetadata, attributes?: Record<string, unknown>): TelemetrySpan {
    const spanCorrelation = { ...correlation, spanId: randomSpanId() };
    this.dispatch({
      kind: "trace",
      event: "span.start",
      name: safeString(name),
      timestamp: this.createdAt().toISOString(),
      correlation: spanCorrelation,
      attributes: safeTelemetryAttributes({ service: this.serviceName, ...attributes }),
    });
    let ended = false;
    const end = (endAttributes?: Record<string, unknown>): void => {
      if (ended) return;
      ended = true;
      this.dispatch({
        kind: "trace",
        event: "span.end",
        name: safeString(name),
        timestamp: this.createdAt().toISOString(),
        correlation: spanCorrelation,
        attributes: safeTelemetryAttributes({ service: this.serviceName, ...endAttributes }),
      });
    };
    return {
      correlation: spanCorrelation,
      end,
      fail: (error: unknown) => end({ outcome: "error", error_type: error instanceof Error ? error.name : "unknown" }),
    };
  }

  defineCounter(name: string, labels: Record<string, string> = {}): void {
    this.updateMetric(this.counters, name, "counter", 0, labels, undefined);
  }

  defineGauge(name: string, labels: Record<string, string> = {}): void {
    this.updateMetric(this.gauges, name, "gauge", 0, labels, undefined);
  }

  increment(name: string, value = 1, labels: Record<string, string> = {}, correlation = this.correlation()): void {
    if (!Number.isFinite(value) || value < 0) return;
    const sample = this.updateMetric(this.counters, name, "counter", value, labels, true);
    if (sample) this.dispatch(this.metricSignal(sample, correlation));
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}, correlation = this.correlation()): void {
    if (!Number.isFinite(value)) return;
    const sample = this.updateMetric(this.gauges, name, "gauge", value, labels, false);
    if (sample) this.dispatch(this.metricSignal(sample, correlation));
  }

  setCounter(name: string, value: number, labels: Record<string, string> = {}, correlation = this.correlation()): void {
    if (!Number.isFinite(value) || value < 0) return;
    const sample = this.updateMetric(this.counters, name, "counter", value, labels, false);
    if (sample) this.dispatch(this.metricSignal(sample, correlation));
  }

  private updateMetric(
    target: Map<string, MetricValue>,
    name: string,
    type: "counter" | "gauge",
    value: number,
    labels: Record<string, string>,
    add: boolean | undefined,
  ): MetricValue | undefined {
    if (!metricName.test(name)) return undefined;
    const safe = safeLabels(labels);
    const key = `${name}|${labelsKey(safe)}`;
    const previous = target.get(key);
    if (!previous && this.counters.size + this.gauges.size >= MAX_METRIC_SERIES) return undefined;
    const nextValue = add === true ? (previous?.value ?? 0) + value : value;
    const sample: MetricValue = { name, type, value: nextValue, labels: safe };
    target.set(key, sample);
    return add === undefined ? undefined : sample;
  }

  private metricSignal(sample: MetricValue, correlation: CorrelationMetadata): MetricSignal {
    return {
      kind: "metric",
      name: sample.name,
      type: sample.type,
      value: sample.value,
      timestamp: this.createdAt().toISOString(),
      correlation,
      labels: sample.labels,
    };
  }

  metricsText(): string {
    const samples = [...this.counters.values(), ...this.gauges.values()];
    const lines: string[] = [];
    const types = new Set<string>();
    for (const sample of samples) {
      if (!types.has(sample.name)) {
        lines.push(`# TYPE ${sample.name} ${sample.type}`);
        types.add(sample.name);
      }
      const labels = Object.entries(sample.labels).map(([key, value]) => `${key}="${prometheusLabelValue(value)}"`);
      lines.push(`${sample.name}${labels.length > 0 ? `{${labels.join(",")}}` : ""} ${sample.value}`);
    }
    return `${lines.join("\n")}\n`;
  }

  signals(): readonly TelemetrySignal[] {
    return this.signalHistory.map((signal) => signal.kind === "metric"
      ? { ...signal, correlation: { ...signal.correlation }, labels: { ...signal.labels } }
      : { ...signal, correlation: { ...signal.correlation }, attributes: { ...signal.attributes } });
  }
}

export function createTelemetry(options: TelemetryOptions): TelemetryRuntime {
  return new TelemetryRuntime(options);
}
