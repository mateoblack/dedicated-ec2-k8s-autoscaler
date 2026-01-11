/**
 * Shared Python EMF (Embedded Metric Format) utilities for Lambda functions.
 *
 * This module provides a MetricsLogger class that emits CloudWatch metrics via
 * structured JSON logs. CloudWatch automatically extracts metrics from the EMF
 * format without requiring direct PutMetricData API calls.
 *
 * Usage in Lambda code generators:
 *   ${getPythonMetricsSetup()}
 *
 * Then in the Lambda handler:
 *   metrics = create_metrics_logger('MyNamespace', context)
 *   metrics.put_metric('RequestCount', 1, COUNT)
 *   metrics.flush()
 */

/**
 * Returns Python code string containing EMF metrics logging setup.
 *
 * The returned string includes:
 * - Unit constants: COUNT, MILLISECONDS, BYTES, SECONDS
 * - MetricsLogger: Class that queues and emits EMF-formatted metrics
 * - create_metrics_logger(): Factory function with default dimensions
 *
 * EMF structure follows CloudWatch specification:
 * {
 *   "_aws": {
 *     "Timestamp": <epoch_ms>,
 *     "CloudWatchMetrics": [{
 *       "Namespace": "...",
 *       "Dimensions": [["dim1", "dim2"]],
 *       "Metrics": [{"Name": "...", "Unit": "..."}]
 *     }]
 *   },
 *   "dim1": "value1",
 *   "metric_name": <numeric_value>
 * }
 *
 * @returns Python code string with EMF metrics setup
 */
export function getPythonMetricsSetup(): string {
  return `
import json
import os
import time

# Unit constants for metric types
COUNT = 'Count'
MILLISECONDS = 'Milliseconds'
BYTES = 'Bytes'
SECONDS = 'Seconds'


class MetricsLogger:
    """
    Logger that emits CloudWatch metrics via EMF (Embedded Metric Format).

    Metrics are queued and flushed to stdout as EMF JSON documents.
    CloudWatch automatically extracts metrics from the structured format.

    EMF limit: Maximum 100 metrics per document. Auto-flushes at limit.

    Example:
        metrics = MetricsLogger('MyApp/Service', {'Environment': 'prod'})
        metrics.put_metric('RequestCount', 1, COUNT)
        metrics.put_metric('Latency', 150, MILLISECONDS)
        metrics.flush()
    """

    MAX_METRICS = 100

    def __init__(self, namespace, default_dimensions=None):
        """
        Initialize MetricsLogger.

        Args:
            namespace: CloudWatch metric namespace (e.g., 'MyApp/Service')
            default_dimensions: Dict of dimension key-value pairs included in all metrics
        """
        self.namespace = namespace
        self.default_dimensions = default_dimensions or {}
        self._metrics = []
        self._dimensions = {}

    def set_dimension(self, key, value):
        """
        Set a dimension for subsequent metrics.

        Dimensions are reset after flush().

        Args:
            key: Dimension name
            value: Dimension value
        """
        self._dimensions[key] = value

    def put_metric(self, name, value, unit=COUNT):
        """
        Queue a metric for emission.

        Auto-flushes if the queue reaches MAX_METRICS (100).

        Args:
            name: Metric name
            value: Numeric metric value
            unit: Metric unit (COUNT, MILLISECONDS, BYTES, SECONDS)
        """
        self._metrics.append({
            'name': name,
            'value': value,
            'unit': unit,
            'dimensions': dict(self._dimensions)
        })

        if len(self._metrics) >= self.MAX_METRICS:
            self.flush()

    def flush(self):
        """
        Emit all queued metrics as EMF JSON and clear the queue.

        Each call outputs one EMF document to stdout. CloudWatch Logs
        agent extracts metrics from the _aws structure automatically.
        """
        if not self._metrics:
            return

        # Build dimension set: default dimensions + all per-metric dimensions
        all_dimensions = dict(self.default_dimensions)
        for metric in self._metrics:
            all_dimensions.update(metric.get('dimensions', {}))

        # Build EMF structure
        emf_doc = {
            '_aws': {
                'Timestamp': int(time.time() * 1000),
                'CloudWatchMetrics': [{
                    'Namespace': self.namespace,
                    'Dimensions': [list(all_dimensions.keys())] if all_dimensions else [],
                    'Metrics': [
                        {'Name': m['name'], 'Unit': m['unit']}
                        for m in self._metrics
                    ]
                }]
            }
        }

        # Add dimension values at root level
        for key, value in all_dimensions.items():
            emf_doc[key] = value

        # Add metric values at root level
        for metric in self._metrics:
            emf_doc[metric['name']] = metric['value']

        # Output EMF document to stdout
        print(json.dumps(emf_doc))

        # Clear queue and per-metric dimensions
        self._metrics = []
        self._dimensions = {}


def create_metrics_logger(namespace, context=None):
    """
    Create a MetricsLogger with standard Lambda dimensions.

    Sets default dimensions from environment and Lambda context:
    - ClusterName: From CLUSTER_NAME environment variable
    - FunctionName: From Lambda context if available

    Args:
        namespace: CloudWatch metric namespace
        context: Lambda context object (optional)

    Returns:
        Configured MetricsLogger instance

    Example:
        def handler(event, context):
            metrics = create_metrics_logger('DedicatedK8s/Etcd', context)
            metrics.put_metric('BackupSuccess', 1, COUNT)
            metrics.flush()
    """
    default_dimensions = {}

    # Add cluster name from environment
    cluster_name = os.environ.get('CLUSTER_NAME')
    if cluster_name:
        default_dimensions['ClusterName'] = cluster_name

    # Add function name from Lambda context
    if context:
        function_name = getattr(context, 'function_name', None)
        if function_name:
            default_dimensions['FunctionName'] = function_name

    return MetricsLogger(namespace, default_dimensions)
`;
}
