/**
 * Unit tests for bash CloudWatch metrics functions.
 *
 * These tests validate that getBashMetricsFunctions() produces correct Bash
 * code with all required metrics functions and proper AWS CLI syntax.
 */

import { getBashMetricsFunctions, getBashLoggingFunctions } from '../../lib/scripts';

describe('Bash Metrics Functions', () => {
  let metricsFunctions: string;

  beforeAll(() => {
    metricsFunctions = getBashMetricsFunctions();
  });

  describe('function output basics', () => {
    test('returns non-empty string', () => {
      expect(metricsFunctions).toBeTruthy();
      expect(typeof metricsFunctions).toBe('string');
      expect(metricsFunctions.length).toBeGreaterThan(0);
    });
  });

  describe('function definitions', () => {
    test('contains emit_metric function', () => {
      expect(metricsFunctions).toContain('emit_metric()');
    });

    test('contains emit_metric_with_dimensions function', () => {
      expect(metricsFunctions).toContain('emit_metric_with_dimensions()');
    });

    test('contains emit_timing_metric function', () => {
      expect(metricsFunctions).toContain('emit_timing_metric()');
    });
  });

  describe('metric unit constants', () => {
    test('contains METRIC_COUNT constant', () => {
      expect(metricsFunctions).toContain('METRIC_COUNT="Count"');
    });

    test('contains METRIC_MILLISECONDS constant', () => {
      expect(metricsFunctions).toContain('METRIC_MILLISECONDS="Milliseconds"');
    });

    test('contains METRIC_SECONDS constant', () => {
      expect(metricsFunctions).toContain('METRIC_SECONDS="Seconds"');
    });

    test('contains METRIC_BYTES constant', () => {
      expect(metricsFunctions).toContain('METRIC_BYTES="Bytes"');
    });

    test('contains METRIC_PERCENT constant', () => {
      expect(metricsFunctions).toContain('METRIC_PERCENT="Percent"');
    });
  });

  describe('AWS CLI integration', () => {
    test('contains aws cloudwatch put-metric-data command', () => {
      expect(metricsFunctions).toContain('aws cloudwatch put-metric-data');
    });

    test('contains --namespace flag', () => {
      expect(metricsFunctions).toContain('--namespace');
    });

    test('contains --metric-name flag', () => {
      expect(metricsFunctions).toContain('--metric-name');
    });

    test('contains --value flag', () => {
      expect(metricsFunctions).toContain('--value');
    });

    test('contains --unit flag', () => {
      expect(metricsFunctions).toContain('--unit');
    });

    test('contains --dimensions flag', () => {
      expect(metricsFunctions).toContain('--dimensions');
    });

    test('contains --region flag', () => {
      expect(metricsFunctions).toContain('--region');
    });
  });

  describe('namespace and dimensions', () => {
    test('uses CLUSTER_NAME for namespace', () => {
      expect(metricsFunctions).toContain('K8sCluster/${CLUSTER_NAME}');
    });

    test('uses INSTANCE_ID for dimension', () => {
      expect(metricsFunctions).toContain('Name=InstanceId,Value=${INSTANCE_ID}');
    });

    test('uses REGION for region flag', () => {
      expect(metricsFunctions).toContain('--region "${REGION}"');
    });

    test('supports custom dimensions format', () => {
      // Check for Name=,Value= pattern in emit_metric_with_dimensions
      expect(metricsFunctions).toContain('Name=');
      expect(metricsFunctions).toContain('Value=');
    });
  });

  describe('error handling', () => {
    test('handles missing CLUSTER_NAME gracefully', () => {
      expect(metricsFunctions).toContain('CLUSTER_NAME not set');
    });

    test('handles missing INSTANCE_ID gracefully', () => {
      expect(metricsFunctions).toContain('INSTANCE_ID not set');
    });

    test('handles missing REGION gracefully', () => {
      expect(metricsFunctions).toContain('REGION not set');
    });

    test('logs warning on failure', () => {
      expect(metricsFunctions).toContain('log_warn');
      expect(metricsFunctions).toContain('Failed to emit metric');
    });

    test('returns success (0) on missing env vars', () => {
      // Functions return 0 on missing env vars to not fail the script
      expect(metricsFunctions).toContain('return 0');
    });
  });

  describe('default values', () => {
    test('defaults unit to Count', () => {
      expect(metricsFunctions).toContain('${3:-Count}');
    });
  });

  describe('module exports', () => {
    test('exports from lib/scripts index', async () => {
      // Use dynamic import with cache busting to get fresh module
      const cacheBuster = Date.now();
      jest.resetModules();
      const scripts = await import(`../../lib/scripts/index`);
      expect(scripts.getBashMetricsFunctions).toBeDefined();
      expect(typeof scripts.getBashMetricsFunctions).toBe('function');
      expect(scripts.getBashMetricsFunctions()).toContain('emit_metric()');
    });
  });

  describe('emit_timing_metric function', () => {
    test('calculates duration from epoch timestamps', () => {
      expect(metricsFunctions).toContain('duration_seconds');
      expect(metricsFunctions).toContain('end_epoch - start_epoch');
    });

    test('uses METRIC_SECONDS for timing', () => {
      expect(metricsFunctions).toContain('${METRIC_SECONDS}');
    });

    test('defaults end_epoch to current time', () => {
      expect(metricsFunctions).toContain('$(date +%s)');
    });
  });
});
