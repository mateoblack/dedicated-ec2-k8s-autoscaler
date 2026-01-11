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
 * @returns Bash script string with retry functions
 */
export function getBashRetryFunctions(): string {
  return `
# Shared retry functions
# Note: MAX_RETRIES and RETRY_DELAY should be defined before this point

# Retry helper function with exponential backoff
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
            if command -v log_info >/dev/null 2>&1; then
                log_info "Command failed, retrying" "delay_seconds=\${delay}"
            else
                echo "Command failed, retrying in \${delay}s..."
            fi
            sleep $delay
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

# Retry helper that captures output
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
            sleep $delay
            delay=$((delay * 2))
        fi

        attempt=$((attempt + 1))
    done

    return 1
}
`;
}
