/**
 * Shared Bash CloudWatch metrics functions for bootstrap scripts.
 *
 * This module provides functions to emit CloudWatch metrics from bash scripts
 * using the AWS CLI put-metric-data command. Metrics are emitted to a
 * cluster-specific namespace with instance dimensions.
 *
 * Usage in bootstrap scripts:
 *   ${getBashMetricsFunctions()}
 *
 * Note: Scripts should define CLUSTER_NAME, INSTANCE_ID, and REGION variables
 * before using the metrics functions.
 */

/**
 * Returns bash script string containing CloudWatch metrics emission functions.
 *
 * The returned string includes:
 * - emit_metric(): Emit a metric with InstanceId dimension
 * - emit_metric_with_dimensions(): Emit a metric with custom dimensions
 * - Unit constants: METRIC_COUNT, METRIC_MILLISECONDS, METRIC_BYTES, etc.
 *
 * All metric functions:
 * - Use namespace: K8sCluster/${CLUSTER_NAME}
 * - Include InstanceId dimension by default
 * - Handle errors gracefully (log warning, don't fail script)
 * - Require CLUSTER_NAME, INSTANCE_ID, REGION environment variables
 *
 * @returns Bash script string with CloudWatch metrics functions
 */
export function getBashMetricsFunctions(): string {
  return `
# CloudWatch metrics emission functions
# Note: CLUSTER_NAME, INSTANCE_ID, and REGION should be defined before using these functions

# Metric unit constants
METRIC_COUNT="Count"
METRIC_MILLISECONDS="Milliseconds"
METRIC_SECONDS="Seconds"
METRIC_BYTES="Bytes"
METRIC_KILOBYTES="Kilobytes"
METRIC_MEGABYTES="Megabytes"
METRIC_PERCENT="Percent"
METRIC_NONE="None"

# Emit a CloudWatch metric with InstanceId dimension
# Usage: emit_metric <metric_name> <value> [unit]
# Example: emit_metric "BootstrapDuration" "45" "Seconds"
# Example: emit_metric "EtcdMemberCount" "3"
emit_metric() {
    local metric_name="\$1"
    local value="\$2"
    local unit="\${3:-Count}"

    if [ -z "\${CLUSTER_NAME:-}" ]; then
        log_warn "Cannot emit metric: CLUSTER_NAME not set" "metric=\$metric_name"
        return 0
    fi

    if [ -z "\${INSTANCE_ID:-}" ]; then
        log_warn "Cannot emit metric: INSTANCE_ID not set" "metric=\$metric_name"
        return 0
    fi

    if [ -z "\${REGION:-}" ]; then
        log_warn "Cannot emit metric: REGION not set" "metric=\$metric_name"
        return 0
    fi

    local namespace="K8sCluster/\${CLUSTER_NAME}"

    aws cloudwatch put-metric-data \\
        --region "\${REGION}" \\
        --namespace "\${namespace}" \\
        --metric-name "\${metric_name}" \\
        --value "\${value}" \\
        --unit "\${unit}" \\
        --dimensions "Name=InstanceId,Value=\${INSTANCE_ID}" \\
        2>/dev/null || log_warn "Failed to emit metric" "metric=\${metric_name}" "value=\${value}"
}

# Emit a CloudWatch metric with custom dimensions
# Usage: emit_metric_with_dimensions <metric_name> <value> <unit> <dimensions>
# Dimensions format: "Name=Key1,Value=Val1 Name=Key2,Value=Val2"
# Example: emit_metric_with_dimensions "NodeReady" "1" "Count" "Name=NodeRole,Value=control-plane Name=InstanceId,Value=\${INSTANCE_ID}"
emit_metric_with_dimensions() {
    local metric_name="\$1"
    local value="\$2"
    local unit="\$3"
    local dimensions="\$4"

    if [ -z "\${CLUSTER_NAME:-}" ]; then
        log_warn "Cannot emit metric: CLUSTER_NAME not set" "metric=\$metric_name"
        return 0
    fi

    if [ -z "\${REGION:-}" ]; then
        log_warn "Cannot emit metric: REGION not set" "metric=\$metric_name"
        return 0
    fi

    local namespace="K8sCluster/\${CLUSTER_NAME}"

    aws cloudwatch put-metric-data \\
        --region "\${REGION}" \\
        --namespace "\${namespace}" \\
        --metric-name "\${metric_name}" \\
        --value "\${value}" \\
        --unit "\${unit}" \\
        --dimensions \${dimensions} \\
        2>/dev/null || log_warn "Failed to emit metric with dimensions" "metric=\${metric_name}" "value=\${value}"
}

# Emit a timing metric (convenience function for measuring durations)
# Usage: emit_timing_metric <metric_name> <start_epoch> [end_epoch]
# If end_epoch not provided, uses current time
# Example:
#   START_TIME=\$(date +%s)
#   # ... do work ...
#   emit_timing_metric "BootstrapDuration" "\$START_TIME"
emit_timing_metric() {
    local metric_name="\$1"
    local start_epoch="\$2"
    local end_epoch="\${3:-\$(date +%s)}"

    local duration_seconds=\$(( end_epoch - start_epoch ))
    emit_metric "\${metric_name}" "\${duration_seconds}" "\${METRIC_SECONDS}"
}
`;
}
