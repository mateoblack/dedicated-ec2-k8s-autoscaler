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
# Usage: retry_command <command>
# Returns: 0 on success, 1 on failure after all retries
retry_command() {
    local cmd="$1"
    local attempt=1
    local delay=$RETRY_DELAY

    while [ $attempt -le $MAX_RETRIES ]; do
        echo "Executing (attempt $attempt/$MAX_RETRIES): $cmd"

        if eval "$cmd"; then
            return 0
        fi

        if [ $attempt -lt $MAX_RETRIES ]; then
            echo "Command failed, retrying in \${delay}s..."
            sleep $delay
            delay=$((delay * 2))  # Exponential backoff
        fi

        attempt=$((attempt + 1))
    done

    echo "ERROR: Command failed after $MAX_RETRIES attempts: $cmd"
    return 1
}

# Retry helper that captures output
# Usage: result=$(retry_command_output <command>)
retry_command_output() {
    local cmd="$1"
    local attempt=1
    local delay=$RETRY_DELAY
    local output=""

    while [ $attempt -le $MAX_RETRIES ]; do
        output=$(eval "$cmd" 2>/dev/null)
        if [ $? -eq 0 ] && [ -n "$output" ]; then
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
