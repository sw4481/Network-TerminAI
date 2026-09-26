import { describe, it, expect } from 'vitest';
import { reclassifyWithApprovals, recountSeverities } from './changeApprovals';
import type { ClassifiedDelta, ExpectedDelta } from './changeVerify';

describe('changeApprovals', () => {
  describe('pathMatchesSegment', () => {
    it('matches exact path segment', () => {
      const deltas: ClassifiedDelta[] = [
        {
          command: 'show ip interface brief',
          family: 'ios',
          severity: 'red',
          path: '/interfaces/GigabitEthernet0/0/status',
          before: 'up',
          after: 'down',
          message: 'Changed',
        },
      ];

      const approved: ExpectedDelta[] = [
        {
          command_substring: 'show ip',
          path_substring: 'status',
          note: 'Expected change',
        },
      ];

      const { deltas: result } = reclassifyWithApprovals(deltas, approved);
      expect(result[0].severity).toBe('green');
      expect(result[0].message).toContain('approved');
    });

    it('does not match if path segment is substring of actual segment', () => {
      const deltas: ClassifiedDelta[] = [
        {
          command: 'show ip interface brief',
          family: 'ios',
          severity: 'red',
          path: '/interfaces/GigabitEthernet0/0/ip',
          before: '10.0.0.50',
          after: '10.0.0.51',
          message: 'IP changed',
        },
      ];

      const approved: ExpectedDelta[] = [
        {
          command_substring: 'show ip',
          path_substring: '10.0.0.5',
          note: 'Should not match',
        },
      ];

      const { deltas: result } = reclassifyWithApprovals(deltas, approved);
      expect(result[0].severity).toBe('red'); // Should remain red
    });

    it('requires minimum 3 characters for command and path', () => {
      const deltas: ClassifiedDelta[] = [
        {
          command: 'show version',
          family: 'ios',
          severity: 'red',
          path: '/version',
          before: '15.0',
          after: '15.1',
          message: 'Version changed',
        },
      ];

      const approved: ExpectedDelta[] = [
        {
          command_substring: 'sh',
          path_substring: 'v',
          note: 'Too short',
        },
      ];

      const { deltas: result } = reclassifyWithApprovals(deltas, approved);
      expect(result[0].severity).toBe('red'); // Should not match
    });

    it('matches multiple deltas', () => {
      const deltas: ClassifiedDelta[] = [
        {
          command: 'show ip interface brief',
          family: 'ios',
          severity: 'red',
          path: '/interfaces/GigabitEthernet0/0/status',
          before: 'up',
          after: 'down',
          message: 'Changed 1',
        },
        {
          command: 'show ip interface brief',
          family: 'ios',
          severity: 'red',
          path: '/interfaces/GigabitEthernet0/1/status',
          before: 'up',
          after: 'down',
          message: 'Changed 2',
        },
      ];

      const approved: ExpectedDelta[] = [
        {
          command_substring: 'show ip',
          path_substring: 'status',
          note: 'Expected change',
        },
      ];

      const { deltas: result } = reclassifyWithApprovals(deltas, approved);
      expect(result[0].severity).toBe('green');
      expect(result[1].severity).toBe('green');
    });

    it('returns matched approvals', () => {
      const deltas: ClassifiedDelta[] = [
        {
          command: 'show ip interface brief',
          family: 'ios',
          severity: 'red',
          path: '/interfaces/GigabitEthernet0/0/status',
          before: 'up',
          after: 'down',
          message: 'Changed',
        },
      ];

      const approved: ExpectedDelta[] = [
        {
          command_substring: 'show ip',
          path_substring: 'status',
          note: 'Expected change',
        },
      ];

      const { matched } = reclassifyWithApprovals(deltas, approved);
      expect(matched).toHaveLength(1);
      expect(matched[0].delta_path).toBe('/interfaces/GigabitEthernet0/0/status');
      expect(matched[0].command).toBe('show ip interface brief');
      expect(matched[0].note).toBe('Expected change');
    });
  });

  describe('recountSeverities', () => {
    it('counts severity levels correctly', () => {
      const deltas: ClassifiedDelta[] = [
        { command: 'cmd1', family: 'ios', severity: 'red', path: '/a', before: 1, after: 2, message: 'm1' },
        { command: 'cmd2', family: 'ios', severity: 'red', path: '/b', before: 1, after: 2, message: 'm2' },
        { command: 'cmd3', family: 'ios', severity: 'yellow', path: '/c', before: 1, after: 2, message: 'm3' },
        { command: 'cmd4', family: 'ios', severity: 'green', path: '/d', before: 1, after: 2, message: 'm4' },
        { command: 'cmd5', family: 'ios', severity: 'green', path: '/e', before: 1, after: 2, message: 'm5' },
        { command: 'cmd6', family: 'ios', severity: 'green', path: '/f', before: 1, after: 2, message: 'm6' },
      ];

      const counts = recountSeverities(deltas);
      expect(counts.red).toBe(2);
      expect(counts.yellow).toBe(1);
      expect(counts.green).toBe(3);
    });

    it('returns zero counts for empty array', () => {
      const counts = recountSeverities([]);
      expect(counts.red).toBe(0);
      expect(counts.yellow).toBe(0);
      expect(counts.green).toBe(0);
    });
  });
});
