/**
 * Unit tests for Python structured logging functions.
 *
 * These tests validate that getPythonLoggingSetup() produces correct Python
 * code with all required logging functions and proper JSON formatting.
 */

import { getPythonLoggingSetup } from '../../lib/scripts/python-logging';

describe('Python Logging Setup', () => {
  let loggingSetup: string;

  beforeAll(() => {
    loggingSetup = getPythonLoggingSetup();
  });

  describe('function output basics', () => {
    test('returns non-empty string', () => {
      expect(loggingSetup).toBeTruthy();
      expect(typeof loggingSetup).toBe('string');
      expect(loggingSetup.length).toBeGreaterThan(0);
    });
  });

  describe('class definitions', () => {
    test('contains JsonFormatter class definition', () => {
      expect(loggingSetup).toContain('class JsonFormatter(logging.Formatter)');
    });

    test('JsonFormatter has format method', () => {
      expect(loggingSetup).toContain('def format(self, record)');
    });
  });

  describe('function definitions', () => {
    test('contains setup_logging function with trace_id parameter', () => {
      expect(loggingSetup).toContain('def setup_logging(context=None, trace_id=None)');
    });
  });

  describe('required imports', () => {
    test('imports json module', () => {
      expect(loggingSetup).toContain('import json');
    });

    test('imports logging module', () => {
      expect(loggingSetup).toContain('import logging');
    });

    test('imports uuid module', () => {
      expect(loggingSetup).toContain('import uuid');
    });

    test('imports datetime', () => {
      expect(loggingSetup).toContain('from datetime import datetime');
    });
  });

  describe('JSON format fields', () => {
    test('includes timestamp field with ISO format', () => {
      expect(loggingSetup).toContain("'timestamp'");
      expect(loggingSetup).toContain('datetime.utcnow().isoformat()');
    });

    test('includes level field', () => {
      expect(loggingSetup).toContain("'level': record.levelname");
    });

    test('includes message field', () => {
      expect(loggingSetup).toContain("'message': record.getMessage()");
    });

    test('includes logger name field', () => {
      expect(loggingSetup).toContain("'logger': record.name");
    });

    test('includes request_id field', () => {
      expect(loggingSetup).toContain("'request_id'");
      expect(loggingSetup).toContain('_request_id');
    });

    test('includes function_name field', () => {
      expect(loggingSetup).toContain("'function_name'");
      expect(loggingSetup).toContain('_function_name');
    });

    test('includes trace_id field', () => {
      expect(loggingSetup).toContain("'trace_id'");
      expect(loggingSetup).toContain('_trace_id');
    });
  });

  describe('Lambda context handling', () => {
    test('sets request_id from context', () => {
      expect(loggingSetup).toContain('aws_request_id');
    });

    test('sets function_name from context', () => {
      expect(loggingSetup).toContain("'function_name'");
      expect(loggingSetup).toMatch(/getattr\(context,\s*['"]function_name['"]/);
    });

    test('uses global variables for context', () => {
      expect(loggingSetup).toContain('global _request_id, _function_name, _trace_id');
    });
  });

  describe('trace_id handling', () => {
    test('auto-generates trace_id using uuid', () => {
      expect(loggingSetup).toContain('uuid.uuid4().hex[:16]');
    });

    test('uses provided trace_id if passed', () => {
      expect(loggingSetup).toContain('trace_id if trace_id else');
    });

    test('trace_id is 16 chars (uses [:16] slice)', () => {
      expect(loggingSetup).toContain('[:16]');
    });

    test('trace_id in standard_attrs to prevent duplication', () => {
      expect(loggingSetup).toMatch(/standard_attrs\s*=\s*\{[^}]*'trace_id'/);
    });
  });

  describe('extra fields handling', () => {
    test('handles extra dict attribute', () => {
      expect(loggingSetup).toContain('record.extra');
      expect(loggingSetup).toContain('log_record.update');
    });

    test('handles individual extra attributes', () => {
      expect(loggingSetup).toContain('record.__dict__');
    });

    test('filters standard attributes', () => {
      expect(loggingSetup).toContain('standard_attrs');
    });

    test('ensures JSON serializability', () => {
      expect(loggingSetup).toContain('json.dumps(value)');
    });
  });

  describe('logger configuration', () => {
    test('sets INFO log level', () => {
      expect(loggingSetup).toContain('logger.setLevel(logging.INFO)');
    });

    test('removes existing handlers', () => {
      expect(loggingSetup).toContain('logger.removeHandler(handler)');
    });

    test('adds StreamHandler', () => {
      expect(loggingSetup).toContain('logging.StreamHandler()');
    });

    test('sets JsonFormatter on handler', () => {
      expect(loggingSetup).toContain('handler.setFormatter(JsonFormatter())');
    });

    test('returns the logger', () => {
      expect(loggingSetup).toContain('return logger');
    });
  });

  describe('JSON output', () => {
    test('uses json.dumps for output', () => {
      expect(loggingSetup).toContain('return json.dumps(log_record)');
    });
  });
});
