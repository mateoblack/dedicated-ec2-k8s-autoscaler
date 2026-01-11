/**
 * Unit tests for bash structured logging functions.
 *
 * These tests validate that getBashLoggingFunctions() produces correct Bash
 * code with all required logging functions and proper JSON formatting.
 */

import { getBashLoggingFunctions } from '../../lib/scripts';
import { execSync } from 'child_process';

describe('Bash Logging Functions', () => {
  let loggingFunctions: string;

  beforeAll(() => {
    loggingFunctions = getBashLoggingFunctions();
  });

  describe('function output basics', () => {
    test('returns non-empty string', () => {
      expect(loggingFunctions).toBeTruthy();
      expect(typeof loggingFunctions).toBe('string');
      expect(loggingFunctions.length).toBeGreaterThan(0);
    });
  });

  describe('function definitions', () => {
    test('contains json_escape function', () => {
      expect(loggingFunctions).toContain('json_escape()');
    });

    test('contains log_json function', () => {
      expect(loggingFunctions).toContain('log_json()');
    });

    test('contains log_info function', () => {
      expect(loggingFunctions).toContain('log_info()');
    });

    test('contains log_warn function', () => {
      expect(loggingFunctions).toContain('log_warn()');
    });

    test('contains log_error function', () => {
      expect(loggingFunctions).toContain('log_error()');
    });

    test('contains log_debug function', () => {
      expect(loggingFunctions).toContain('log_debug()');
    });

    test('contains generate_trace_id function', () => {
      expect(loggingFunctions).toContain('generate_trace_id()');
    });

    test('contains init_trace_id function', () => {
      expect(loggingFunctions).toContain('init_trace_id()');
    });
  });

  describe('JSON format patterns', () => {
    test('includes timestamp generation', () => {
      expect(loggingFunctions).toContain('date -u +%Y-%m-%dT%H:%M:%SZ');
    });

    test('includes level field', () => {
      expect(loggingFunctions).toContain('"level"');
    });

    test('includes message field', () => {
      expect(loggingFunctions).toContain('"message"');
    });

    test('includes instance_id field', () => {
      expect(loggingFunctions).toContain('"instance_id"');
    });

    test('includes stage field', () => {
      expect(loggingFunctions).toContain('"stage"');
    });

    test('includes timestamp field', () => {
      expect(loggingFunctions).toContain('"timestamp"');
    });

    test('includes trace_id field', () => {
      expect(loggingFunctions).toContain('trace_id');
    });
  });

  describe('logging levels', () => {
    test('log_info uses INFO level', () => {
      expect(loggingFunctions).toContain('log_json "INFO"');
    });

    test('log_warn uses WARN level', () => {
      expect(loggingFunctions).toContain('log_json "WARN"');
    });

    test('log_error uses ERROR level', () => {
      expect(loggingFunctions).toContain('log_json "ERROR"');
    });

    test('log_debug uses DEBUG level', () => {
      expect(loggingFunctions).toContain('log_json "DEBUG"');
    });
  });

  describe('debug level respects LOG_LEVEL', () => {
    test('log_debug checks LOG_LEVEL variable', () => {
      expect(loggingFunctions).toContain('LOG_LEVEL');
      expect(loggingFunctions).toMatch(/LOG_LEVEL.*DEBUG/);
    });
  });

  describe('JSON escaping', () => {
    test('escapes backslashes', () => {
      expect(loggingFunctions).toContain('\\\\');
    });

    test('escapes quotes', () => {
      expect(loggingFunctions).toContain('\\"');
    });

    test('handles tab characters', () => {
      expect(loggingFunctions).toContain('\\t');
    });

    test('handles newline characters', () => {
      expect(loggingFunctions).toContain('\\n');
    });
  });

  describe('key=value pair support', () => {
    test('handles additional parameters', () => {
      // Check for pattern that parses key=value pairs
      expect(loggingFunctions).toContain('key=');
      expect(loggingFunctions).toContain('value=');
    });

    test('extracts key from pair', () => {
      expect(loggingFunctions).toContain('%%=*');
    });

    test('extracts value from pair', () => {
      expect(loggingFunctions).toContain('#*=');
    });
  });

  describe('bash execution tests', () => {
    test('produces valid JSON with basic log_info', () => {
      const script = `
#!/bin/bash
${loggingFunctions}

INSTANCE_ID="i-1234567890abcdef0"
BOOTSTRAP_STAGE="test-stage"
log_info "Test message"
`;
      const output = execSync(`bash -c '${script.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf8',
      }).trim();

      const json = JSON.parse(output);
      expect(json.level).toBe('INFO');
      expect(json.message).toBe('Test message');
      expect(json.instance_id).toBe('i-1234567890abcdef0');
      expect(json.stage).toBe('test-stage');
      expect(json.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    test('produces valid JSON with log_error', () => {
      const script = `
#!/bin/bash
${loggingFunctions}

INSTANCE_ID="i-test"
BOOTSTRAP_STAGE="error-stage"
log_error "An error occurred"
`;
      const output = execSync(`bash -c '${script.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf8',
      }).trim();

      const json = JSON.parse(output);
      expect(json.level).toBe('ERROR');
      expect(json.message).toBe('An error occurred');
    });

    test('produces valid JSON with log_warn', () => {
      const script = `
#!/bin/bash
${loggingFunctions}

log_warn "Warning message"
`;
      const output = execSync(`bash -c '${script.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf8',
      }).trim();

      const json = JSON.parse(output);
      expect(json.level).toBe('WARN');
      expect(json.message).toBe('Warning message');
    });

    test('handles additional key=value pairs', () => {
      const script = `
#!/bin/bash
${loggingFunctions}

INSTANCE_ID="i-test"
log_info "Process started" "component=kubelet" "attempt=1"
`;
      const output = execSync(`bash -c '${script.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf8',
      }).trim();

      const json = JSON.parse(output);
      expect(json.level).toBe('INFO');
      expect(json.message).toBe('Process started');
      expect(json.component).toBe('kubelet');
      expect(json.attempt).toBe('1');
    });

    test('escapes quotes in message correctly', () => {
      const script = `
#!/bin/bash
${loggingFunctions}

log_info "Message with \\"quotes\\""
`;
      const output = execSync(`bash -c '${script.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf8',
      }).trim();

      const json = JSON.parse(output);
      expect(json.message).toBe('Message with "quotes"');
    });

    test('log_debug only outputs when LOG_LEVEL=DEBUG', () => {
      // Without LOG_LEVEL=DEBUG, should output nothing
      const scriptNoDebug = `
#!/bin/bash
${loggingFunctions}

log_debug "Debug message"
`;
      const outputNoDebug = execSync(
        `bash -c '${scriptNoDebug.replace(/'/g, "'\"'\"'")}'`,
        {
          encoding: 'utf8',
        }
      ).trim();
      expect(outputNoDebug).toBe('');

      // With LOG_LEVEL=DEBUG, should output JSON
      const scriptWithDebug = `
#!/bin/bash
${loggingFunctions}

LOG_LEVEL="DEBUG"
log_debug "Debug message"
`;
      const outputWithDebug = execSync(
        `bash -c '${scriptWithDebug.replace(/'/g, "'\"'\"'")}'`,
        {
          encoding: 'utf8',
        }
      ).trim();

      const json = JSON.parse(outputWithDebug);
      expect(json.level).toBe('DEBUG');
      expect(json.message).toBe('Debug message');
    });

    test('works without INSTANCE_ID set', () => {
      const script = `
#!/bin/bash
${loggingFunctions}

unset INSTANCE_ID
log_info "Message without instance"
`;
      const output = execSync(`bash -c '${script.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf8',
      }).trim();

      const json = JSON.parse(output);
      expect(json.level).toBe('INFO');
      expect(json.message).toBe('Message without instance');
      expect(json.instance_id).toBeUndefined();
    });

    test('includes trace_id when TRACE_ID is set', () => {
      const script = `
#!/bin/bash
${loggingFunctions}

TRACE_ID="abc123def456ghij"
log_info "Message with trace"
`;
      const output = execSync(`bash -c '${script.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf8',
      }).trim();

      const json = JSON.parse(output);
      expect(json.level).toBe('INFO');
      expect(json.message).toBe('Message with trace');
      expect(json.trace_id).toBe('abc123def456ghij');
    });

    test('works without TRACE_ID set (no error)', () => {
      const script = `
#!/bin/bash
${loggingFunctions}

unset TRACE_ID
log_info "Message without trace"
`;
      const output = execSync(`bash -c '${script.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf8',
      }).trim();

      const json = JSON.parse(output);
      expect(json.level).toBe('INFO');
      expect(json.message).toBe('Message without trace');
      expect(json.trace_id).toBeUndefined();
    });

    test('generate_trace_id produces 16-char hex string', () => {
      const script = `
#!/bin/bash
${loggingFunctions}

trace_id=$(generate_trace_id)
echo "\$trace_id"
`;
      const output = execSync(`bash -c '${script.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf8',
      }).trim();

      expect(output).toMatch(/^[0-9a-f]{16}$/);
    });

    test('init_trace_id sets TRACE_ID when not set', () => {
      const script = `
#!/bin/bash
${loggingFunctions}

unset TRACE_ID
init_trace_id
log_info "Auto trace"
`;
      const output = execSync(`bash -c '${script.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf8',
      }).trim();

      const json = JSON.parse(output);
      expect(json.trace_id).toMatch(/^[0-9a-f]{16}$/);
    });

    test('init_trace_id preserves existing TRACE_ID', () => {
      const script = `
#!/bin/bash
${loggingFunctions}

TRACE_ID="existing12345678"
init_trace_id
log_info "Existing trace"
`;
      const output = execSync(`bash -c '${script.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf8',
      }).trim();

      const json = JSON.parse(output);
      expect(json.trace_id).toBe('existing12345678');
    });
  });
});
