/**
 * Shared Python structured logging utilities for Lambda functions.
 *
 * This module provides a JSON structured logging setup that can be interpolated
 * into Python Lambda code. It configures the Python logger to output JSON-formatted
 * log records compatible with CloudWatch Logs Insights.
 *
 * Usage in Lambda code generators:
 *   ${getPythonLoggingSetup()}
 *
 * Then in the Lambda handler:
 *   setup_logging(context)
 *   logger.info("Message", extra={'key': 'value'})
 */

/**
 * Returns Python code string containing JSON structured logging setup.
 *
 * The returned string includes:
 * - JsonFormatter: Custom formatter that outputs JSON log records
 * - setup_logging(): Function to configure the logger with Lambda context
 *
 * JSON log format includes:
 * - timestamp: ISO8601 format with Z suffix
 * - level: Log level (INFO, WARNING, ERROR, etc.)
 * - message: The log message
 * - logger: Logger name
 * - request_id: Lambda request ID from context
 * - function_name: Lambda function name from context
 * - Any extra fields passed via the extra parameter
 *
 * @returns Python code string with logging setup
 */
export function getPythonLoggingSetup(): string {
  return `
import json
import logging
import uuid
from datetime import datetime

class JsonFormatter(logging.Formatter):
    """
    Custom log formatter that outputs JSON-structured log records.

    Each log record includes standard fields (timestamp, level, message)
    plus Lambda context fields (request_id, function_name) and any
    extra fields passed to the logger.
    """

    def format(self, record):
        log_record = {
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'level': record.levelname,
            'message': record.getMessage(),
            'logger': record.name,
            'request_id': getattr(record, 'request_id', _request_id),
            'function_name': getattr(record, 'function_name', _function_name),
            'trace_id': getattr(record, 'trace_id', _trace_id),
        }

        # Include any extra fields passed via extra parameter
        if hasattr(record, 'extra') and isinstance(record.extra, dict):
            log_record.update(record.extra)

        # Also check for individual extra attributes on the record
        # This handles logger.info("msg", extra={'key': 'value'}) pattern
        standard_attrs = {
            'name', 'msg', 'args', 'created', 'filename', 'funcName',
            'levelname', 'levelno', 'lineno', 'module', 'msecs',
            'pathname', 'process', 'processName', 'relativeCreated',
            'stack_info', 'exc_info', 'exc_text', 'thread', 'threadName',
            'message', 'request_id', 'function_name', 'trace_id', 'extra', 'taskName'
        }
        for key, value in record.__dict__.items():
            if key not in standard_attrs and not key.startswith('_'):
                try:
                    # Ensure value is JSON serializable
                    json.dumps(value)
                    log_record[key] = value
                except (TypeError, ValueError):
                    log_record[key] = str(value)

        return json.dumps(log_record)


# Global context (set by handler via setup_logging)
_request_id = None
_function_name = None
_trace_id = None


def setup_logging(context=None, trace_id=None):
    """
    Configure the root logger for JSON structured output.

    Call this at the start of your Lambda handler to set up
    structured logging with Lambda context information.

    Args:
        context: Lambda context object (optional). If provided,
                 request_id and function_name will be included
                 in all log records.
        trace_id: Correlation ID for tracing related operations (optional).
                  If not provided, a 16-char hex ID will be auto-generated.

    Returns:
        The configured root logger.

    Example:
        def handler(event, context):
            logger = setup_logging(context)
            logger.info("Processing event", extra={'event_type': 'test'})
    """
    global _request_id, _function_name, _trace_id

    if context:
        _request_id = getattr(context, 'aws_request_id', None)
        _function_name = getattr(context, 'function_name', None)

    # Set trace_id: use provided value, or generate a 16-char hex ID
    _trace_id = trace_id if trace_id else uuid.uuid4().hex[:16]

    logger = logging.getLogger()
    logger.setLevel(logging.INFO)

    # Remove existing handlers and add JSON handler
    for handler in logger.handlers[:]:
        logger.removeHandler(handler)

    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    logger.addHandler(handler)

    return logger
`;
}
