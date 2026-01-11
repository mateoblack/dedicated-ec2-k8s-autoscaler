/**
 * Shared Python retry utilities for Lambda functions.
 *
 * This module provides a retry_with_backoff function that can be interpolated
 * into Python Lambda code. It implements exponential backoff retry logic
 * for operations that may fail transiently.
 *
 * Usage in Lambda code generators:
 *   ${getPythonRetryUtils()}
 *
 * Note: The Lambda code should define retriable exception classes with
 * an is_retriable attribute before using this utility.
 */

/**
 * Returns Python code string containing retry utility function.
 *
 * The returned string includes:
 * - retry_with_backoff(): Generic retry function with exponential backoff
 *
 * The function handles:
 * - Exponential backoff (base_delay * 2^attempt)
 * - Checking is_retriable attribute on exceptions
 * - Logging of attempts and failures
 *
 * @returns Python code string with retry utility function
 */
export function getPythonRetryUtils(): string {
  return `
def retry_with_backoff(
    operation,
    operation_name,
    max_retries=3,
    base_delay=5,
    retriable_exceptions=(Exception,)
):
    """
    Execute operation with exponential backoff retry logic.

    Args:
        operation: Callable to execute (no arguments - use closure or functools.partial)
        operation_name: Human-readable name for logging
        max_retries: Maximum number of attempts
        base_delay: Base delay in seconds (exponential: base_delay * 2^attempt)
        retriable_exceptions: Tuple of exception types to catch and retry

    Returns:
        Result of operation() on success, or None on failure

    Raises:
        The last exception if operation fails all retries and caller needs it
    """
    last_error = None

    for attempt in range(1, max_retries + 1):
        try:
            logger.info(f"Attempt {attempt}/{max_retries}: {operation_name}")
            return operation()
        except retriable_exceptions as e:
            last_error = e
            is_retriable = getattr(e, 'is_retriable', True)
            logger.warning(f"{operation_name} attempt {attempt} failed: {str(e)}")

            if not is_retriable:
                logger.error(f"{operation_name} error is not retriable, giving up")
                break

            if attempt < max_retries:
                delay = base_delay * (2 ** (attempt - 1))
                logger.info(f"Waiting {delay}s before retry...")
                time.sleep(delay)
        except Exception as e:
            last_error = e
            logger.error(f"Unexpected error in {operation_name} on attempt {attempt}: {str(e)}")
            if attempt < max_retries:
                time.sleep(base_delay)

    logger.error(f"All {max_retries} attempts failed for {operation_name}. Last error: {str(last_error)}")
    return None
`;
}
