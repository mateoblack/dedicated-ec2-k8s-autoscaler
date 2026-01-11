/**
 * Unit tests for Python EMF metrics functions.
 *
 * These tests validate that getPythonMetricsSetup() produces correct Python
 * code with the MetricsLogger class and EMF format compliance.
 */

import { getPythonMetricsSetup } from '../../lib/scripts/python-metrics';

describe('Python Metrics Setup', () => {
  let metricsSetup: string;

  beforeAll(() => {
    metricsSetup = getPythonMetricsSetup();
  });

  describe('function output basics', () => {
    test('returns non-empty string', () => {
      expect(metricsSetup).toBeTruthy();
      expect(typeof metricsSetup).toBe('string');
      expect(metricsSetup.length).toBeGreaterThan(0);
    });
  });

  describe('class definitions', () => {
    test('contains MetricsLogger class definition', () => {
      expect(metricsSetup).toContain('class MetricsLogger:');
    });

    test('MetricsLogger has put_metric method', () => {
      expect(metricsSetup).toContain('def put_metric(self, name, value, unit=COUNT)');
    });

    test('MetricsLogger has set_dimension method', () => {
      expect(metricsSetup).toContain('def set_dimension(self, key, value)');
    });

    test('MetricsLogger has flush method', () => {
      expect(metricsSetup).toContain('def flush(self)');
    });

    test('MetricsLogger has __init__ method', () => {
      expect(metricsSetup).toContain('def __init__(self, namespace, default_dimensions=None)');
    });
  });

  describe('function definitions', () => {
    test('contains create_metrics_logger function', () => {
      expect(metricsSetup).toContain('def create_metrics_logger(namespace, context=None)');
    });
  });

  describe('unit constants', () => {
    test('defines COUNT constant', () => {
      expect(metricsSetup).toContain("COUNT = 'Count'");
    });

    test('defines MILLISECONDS constant', () => {
      expect(metricsSetup).toContain("MILLISECONDS = 'Milliseconds'");
    });

    test('defines BYTES constant', () => {
      expect(metricsSetup).toContain("BYTES = 'Bytes'");
    });

    test('defines SECONDS constant', () => {
      expect(metricsSetup).toContain("SECONDS = 'Seconds'");
    });
  });

  describe('required imports', () => {
    test('imports json module', () => {
      expect(metricsSetup).toContain('import json');
    });

    test('imports os module', () => {
      expect(metricsSetup).toContain('import os');
    });

    test('imports time module', () => {
      expect(metricsSetup).toContain('import time');
    });
  });

  describe('EMF structure', () => {
    test('includes _aws key for EMF', () => {
      expect(metricsSetup).toContain("'_aws'");
    });

    test('includes CloudWatchMetrics array', () => {
      expect(metricsSetup).toContain("'CloudWatchMetrics'");
    });

    test('includes Namespace field', () => {
      expect(metricsSetup).toContain("'Namespace'");
    });

    test('includes Dimensions field', () => {
      expect(metricsSetup).toContain("'Dimensions'");
    });

    test('includes Metrics array', () => {
      expect(metricsSetup).toContain("'Metrics'");
    });

    test('includes Timestamp field', () => {
      expect(metricsSetup).toContain("'Timestamp'");
    });

    test('uses milliseconds epoch for timestamp', () => {
      expect(metricsSetup).toContain('int(time.time() * 1000)');
    });
  });

  describe('metric properties', () => {
    test('includes Name in metric definition', () => {
      expect(metricsSetup).toContain("'Name': m['name']");
    });

    test('includes Unit in metric definition', () => {
      expect(metricsSetup).toContain("'Unit': m['unit']");
    });
  });

  describe('default dimensions', () => {
    test('gets ClusterName from environment', () => {
      expect(metricsSetup).toContain("os.environ.get('CLUSTER_NAME')");
    });

    test('gets function_name from Lambda context', () => {
      expect(metricsSetup).toContain("getattr(context, 'function_name', None)");
    });
  });

  describe('auto-flush behavior', () => {
    test('defines MAX_METRICS constant', () => {
      expect(metricsSetup).toContain('MAX_METRICS = 100');
    });

    test('auto-flushes at limit', () => {
      expect(metricsSetup).toContain('if len(self._metrics) >= self.MAX_METRICS');
    });
  });

  describe('JSON output', () => {
    test('uses json.dumps for output', () => {
      expect(metricsSetup).toContain('json.dumps(emf_doc)');
    });

    test('prints EMF document to stdout', () => {
      expect(metricsSetup).toContain('print(json.dumps(emf_doc))');
    });
  });

  describe('module integration', () => {
    test('can be imported from lib/scripts', () => {
      const { getPythonMetricsSetup: importedFn } = require('../../lib/scripts');
      expect(typeof importedFn).toBe('function');
      expect(importedFn()).toBe(metricsSetup);
    });
  });
});
