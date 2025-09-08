import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

// Minimal in-memory metric exporter (no persistence yet)
class InMemoryMetricExporter {
  export(_metrics, resultCallback) {
    resultCallback({ code: 0 });
  }
  shutdown() { return Promise.resolve(); }
}

export function initOTel({ serviceName = 'lite-otel-openai-status' } = {}) {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
  });

  const metricExporter = new InMemoryMetricExporter();
  const meterProvider = new MeterProvider({ resource });
  meterProvider.addMetricReader(new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60000 }));

  const sdk = new NodeSDK({ resource, meterProvider });
  sdk.start();

  return { sdk, meterProvider };
}
