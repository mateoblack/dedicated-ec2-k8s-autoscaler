/**
 * Shared Bash structured logging functions for bootstrap scripts.
 *
 * This module provides JSON-formatted logging functions that can be
 * interpolated into bash scripts. The structured format enables
 * CloudWatch Logs Insights queries and consistent monitoring.
 *
 * Usage in bootstrap scripts:
 *   ${getBashLoggingFunctions()}
 *
 * Note: Scripts should define INSTANCE_ID and BOOTSTRAP_STAGE variables
 * before using the logging functions for full context.
 */

/**
 * Returns bash script string containing structured JSON logging functions.
 *
 * The returned string includes:
 * - log_json(): Core function that outputs JSON with timestamp, level, message, and context
 * - log_info(): INFO level convenience wrapper
 * - log_warn(): WARN level convenience wrapper
 * - log_error(): ERROR level convenience wrapper
 * - log_debug(): DEBUG level convenience wrapper (respects LOG_LEVEL variable)
 *
 * JSON output format:
 * {"timestamp":"2024-01-01T12:00:00Z","level":"INFO","message":"text","instance_id":"i-xxx","stage":"bootstrap-stage"}
 *
 * All functions support optional key=value pairs for additional context:
 *   log_info "Starting process" "component=kubelet" "attempt=1"
 *
 * @returns Bash script string with structured logging functions
 */
export function getBashLoggingFunctions(): string {
  return `
# Shared structured logging functions
# Note: INSTANCE_ID, BOOTSTRAP_STAGE, and TRACE_ID should be defined before using these functions
# Use init_trace_id at script start to auto-generate TRACE_ID if not already set

# Generate a 16-char hex trace ID using /dev/urandom
# Usage: trace_id=$(generate_trace_id)
generate_trace_id() {
    head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \\n'
}

# Initialize TRACE_ID if not already set
# Call at the start of bootstrap scripts to ensure trace ID is available
# Usage: init_trace_id
init_trace_id() {
    if [ -z "\${TRACE_ID:-}" ]; then
        TRACE_ID=\$(generate_trace_id)
        export TRACE_ID
    fi
}

# JSON string escaping helper
# Escapes quotes, backslashes, newlines, tabs for valid JSON strings
# Usage: escaped=$(json_escape "string with special chars")
json_escape() {
    local input="\$1"
    # Escape backslashes first, then quotes, then control characters
    input="\${input//\\\\/\\\\\\\\}"
    input="\${input//\\"/\\\\\\"}"
    input="\${input//	/\\\\t}"
    # Replace actual newlines with \\n
    input="\$(printf '%s' "\$input" | tr '\\n' '\\036' | sed 's/\\036/\\\\n/g')"
    printf '%s' "\$input"
}

# Core JSON logging function
# Usage: log_json <level> <message> [key=value...]
# Output: {"timestamp":"ISO8601","level":"LEVEL","message":"msg","instance_id":"i-xxx","stage":"stage",...}
log_json() {
    local level="\$1"
    local message="\$2"
    shift 2

    local timestamp
    timestamp=\$(date -u +%Y-%m-%dT%H:%M:%SZ)

    local escaped_message
    escaped_message=\$(json_escape "\$message")

    # Start building JSON
    local json="{\\"timestamp\\":\\"\$timestamp\\",\\"level\\":\\"\$level\\",\\"message\\":\\"\$escaped_message\\""

    # Add instance_id if available
    if [ -n "\${INSTANCE_ID:-}" ]; then
        json="\$json,\\"instance_id\\":\\"\$INSTANCE_ID\\""
    fi

    # Add stage if available
    if [ -n "\${BOOTSTRAP_STAGE:-}" ]; then
        local escaped_stage
        escaped_stage=\$(json_escape "\$BOOTSTRAP_STAGE")
        json="\$json,\\"stage\\":\\"\$escaped_stage\\""
    fi

    # Add trace_id if available
    if [ -n "\${TRACE_ID:-}" ]; then
        json="\$json,\\"trace_id\\":\\"\$TRACE_ID\\""
    fi

    # Process additional key=value pairs
    while [ \$# -gt 0 ]; do
        local pair="\$1"
        local key="\${pair%%=*}"
        local value="\${pair#*=}"

        if [ "\$key" != "\$pair" ]; then
            local escaped_value
            escaped_value=\$(json_escape "\$value")
            json="\$json,\\"\$key\\":\\"\$escaped_value\\""
        fi
        shift
    done

    json="\$json}"
    echo "\$json"
}

# INFO level logging
# Usage: log_info <message> [key=value...]
log_info() {
    log_json "INFO" "\$@"
}

# WARN level logging
# Usage: log_warn <message> [key=value...]
log_warn() {
    log_json "WARN" "\$@"
}

# ERROR level logging
# Usage: log_error <message> [key=value...]
log_error() {
    log_json "ERROR" "\$@"
}

# DEBUG level logging (respects LOG_LEVEL variable)
# Only outputs if LOG_LEVEL is set to "DEBUG"
# Usage: log_debug <message> [key=value...]
log_debug() {
    if [ "\${LOG_LEVEL:-}" = "DEBUG" ]; then
        log_json "DEBUG" "\$@"
    fi
}
`;
}
