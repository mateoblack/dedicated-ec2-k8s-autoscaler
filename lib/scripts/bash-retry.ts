/**
 * Shared Bash retry functions for bootstrap scripts.
 *
 * This module provides retry_command and retry_command_output functions
 * that can be interpolated into bash scripts. These functions implement
 * exponential backoff retry logic for commands that may fail transiently.
 *
 * Usage in bootstrap scripts:
 *   ${getBashRetryFunctions()}
 *
 * Note: Scripts should define MAX_RETRIES and RETRY_DELAY constants
 * BEFORE this interpolation point to override the defaults.
 *
 * Jitter: Both retry functions include random jitter to prevent thundering herd
 * when multiple EC2 instances retry simultaneously. The jitter adds 0-30% of the
 * delay value (configurable via JITTER_FACTOR, default 0.3).
 */

/**
 * Returns bash script string containing retry helper functions.
 *
 * The returned string includes:
 * - retry_command(): Retries a command with exponential backoff, returns success/failure
 * - retry_command_output(): Retries a command and captures its output
 *
 * Both functions use MAX_RETRIES and RETRY_DELAY variables which should be
 * defined by the calling script before this interpolation point.
 *
 * Jitter configuration:
 * - JITTER_FACTOR: Fraction of delay to add as random jitter (default 0.3 = 30%)
 * - Set JITTER_FACTOR=0 to disable jitter
 * - Jitter uses bash $RANDOM (0-32767) for randomization
 *
 * @returns Bash script string with retry functions
 */
export function getBashRetryFunctions(): string {
  return `
# Shared retry functions
# Note: MAX_RETRIES and RETRY_DELAY should be defined before this point
# JITTER_FACTOR: Fraction of delay to add as random jitter (default 0.3 = 30%)
#   - Prevents thundering herd when multiple EC2 instances retry simultaneously
#   - Set JITTER_FACTOR=0 to disable jitter
: "\${JITTER_FACTOR:=0.3}"

# Retry helper function with exponential backoff and jitter
# Usage: retry_command <cmd> [args...]
# Returns: 0 on success, 1 on failure after all retries
retry_command() {
    local attempt=1
    local delay=$RETRY_DELAY

    while [ $attempt -le $MAX_RETRIES ]; do
        # Use structured logging if available, otherwise fall back to echo
        if command -v log_info >/dev/null 2>&1; then
            log_info "Executing command" "attempt=$attempt" "max_attempts=$MAX_RETRIES" "command=$*"
        else
            echo "Executing (attempt $attempt/$MAX_RETRIES): $*"
        fi

        if "$@"; then
            return 0
        fi

        if [ $attempt -lt $MAX_RETRIES ]; then
            # Calculate jitter: random value between 0 and delay * JITTER_FACTOR
            # Uses $RANDOM (0-32767) for randomization
            local jitter_max=$(awk "BEGIN {printf \\"%d\\", $delay * $JITTER_FACTOR}")
            local jitter=0
            if [ "$jitter_max" -gt 0 ]; then
                jitter=$((RANDOM % (jitter_max + 1)))
            fi
            local actual_delay=$((delay + jitter))

            if command -v log_info >/dev/null 2>&1; then
                log_info "Command failed, retrying" "delay_seconds=\${actual_delay}" "base_delay=\${delay}" "jitter=\${jitter}"
            else
                echo "Command failed, retrying in \${actual_delay}s..."
            fi
            sleep $actual_delay
            delay=$((delay * 2))  # Exponential backoff
        fi

        attempt=$((attempt + 1))
    done

    # Use structured logging if available, otherwise fall back to echo
    if command -v log_error >/dev/null 2>&1; then
        log_error "Command failed after all retries" "attempts=$MAX_RETRIES" "command=$*" "check=Review command output above for the actual error" "hint=If error is consistent across retries, issue may be persistent not transient"
    else
        echo "ERROR: Command failed after $MAX_RETRIES attempts: $*. Check output above for error details."
    fi
    return 1
}

# Retry helper that captures output (with jitter)
# Usage: result=$(retry_command_output <cmd> [args...])
retry_command_output() {
    local attempt=1
    local delay=$RETRY_DELAY
    local output=""

    while [ $attempt -le $MAX_RETRIES ]; do
        if output=$("$@" 2>/dev/null) && [ -n "$output" ]; then
            echo "$output"
            return 0
        fi

        if [ $attempt -lt $MAX_RETRIES ]; then
            # Calculate jitter: random value between 0 and delay * JITTER_FACTOR
            # Uses $RANDOM (0-32767) for randomization
            local jitter_max=$(awk "BEGIN {printf \\"%d\\", $delay * $JITTER_FACTOR}")
            local jitter=0
            if [ "$jitter_max" -gt 0 ]; then
                jitter=$((RANDOM % (jitter_max + 1)))
            fi
            local actual_delay=$((delay + jitter))
            sleep $actual_delay
            delay=$((delay * 2))
        fi

        attempt=$((attempt + 1))
    done

    return 1
}

# Retry helper with per-operation timeout and jitter
# Usage: retry_command_timeout <timeout_seconds> <cmd> [args...]
# Returns: 0 on success, 1 on failure after all retries
# Exit codes:
#   - timeout returns 124 when command times out
#   - timeout returns 137 (128+9) if command was killed by SIGKILL
#   - Both are treated as retriable failures
retry_command_timeout() {
    local timeout_seconds=$1
    shift
    local attempt=1
    local delay=$RETRY_DELAY

    while [ $attempt -le $MAX_RETRIES ]; do
        if command -v log_info >/dev/null 2>&1; then
            log_info "Executing command with timeout" "attempt=$attempt" "max_attempts=$MAX_RETRIES" "timeout_seconds=$timeout_seconds" "command=$*"
        else
            echo "Executing (attempt $attempt/$MAX_RETRIES, timeout ${timeout_seconds}s): $*"
        fi

        local exit_code=0
        timeout $timeout_seconds "$@" || exit_code=$?

        if [ $exit_code -eq 0 ]; then
            return 0
        fi

        # Handle timeout-specific exit codes
        local failure_reason="command_failed"
        if [ $exit_code -eq 124 ]; then
            failure_reason="timeout"
        elif [ $exit_code -eq 137 ]; then
            failure_reason="killed"
        fi

        if [ $attempt -lt $MAX_RETRIES ]; then
            # Calculate jitter: random value between 0 and delay * JITTER_FACTOR
            local jitter_max=$(awk "BEGIN {printf \\"%d\\", $delay * $JITTER_FACTOR}")
            local jitter=0
            if [ "$jitter_max" -gt 0 ]; then
                jitter=$((RANDOM % (jitter_max + 1)))
            fi
            local actual_delay=$((delay + jitter))

            if command -v log_info >/dev/null 2>&1; then
                log_info "Command failed, retrying" "reason=$failure_reason" "exit_code=$exit_code" "delay_seconds=\${actual_delay}" "base_delay=\${delay}" "jitter=\${jitter}"
            else
                echo "Command failed ($failure_reason, exit=$exit_code), retrying in \${actual_delay}s..."
            fi
            sleep $actual_delay
            delay=$((delay * 2))  # Exponential backoff
        fi

        attempt=$((attempt + 1))
    done

    if command -v log_error >/dev/null 2>&1; then
        log_error "Command failed after all retries" "attempts=$MAX_RETRIES" "timeout_seconds=$timeout_seconds" "command=$*"
    else
        echo "ERROR: Command failed after $MAX_RETRIES attempts (timeout=${timeout_seconds}s): $*"
    fi
    return 1
}

# Retry helper that captures output with per-operation timeout (with jitter)
# Usage: result=$(retry_command_output_timeout <timeout_seconds> <cmd> [args...])
# Returns: 0 on success with output, 1 on failure after all retries
retry_command_output_timeout() {
    local timeout_seconds=$1
    shift
    local attempt=1
    local delay=$RETRY_DELAY
    local output=""

    while [ $attempt -le $MAX_RETRIES ]; do
        local exit_code=0
        output=$(timeout $timeout_seconds "$@" 2>/dev/null) || exit_code=$?

        if [ $exit_code -eq 0 ] && [ -n "$output" ]; then
            echo "$output"
            return 0
        fi

        if [ $attempt -lt $MAX_RETRIES ]; then
            # Calculate jitter: random value between 0 and delay * JITTER_FACTOR
            local jitter_max=$(awk "BEGIN {printf \\"%d\\", $delay * $JITTER_FACTOR}")
            local jitter=0
            if [ "$jitter_max" -gt 0 ]; then
                jitter=$((RANDOM % (jitter_max + 1)))
            fi
            local actual_delay=$((delay + jitter))
            sleep $actual_delay
            delay=$((delay * 2))
        fi

        attempt=$((attempt + 1))
    done

    return 1
}
`;
}
