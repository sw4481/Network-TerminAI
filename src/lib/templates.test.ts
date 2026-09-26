// src/lib/templates.test.ts
import { describe, it, expect } from 'vitest';
import { TEMPLATES, getTemplatesByCategory, getCategoryName, fillTemplate } from './templates';

describe('templates', () => {
  describe('TEMPLATES', () => {
    it('should have at least 17 templates', () => {
      expect(TEMPLATES.length).toBeGreaterThanOrEqual(17);
    });

    it('should have templates in all 4 categories', () => {
      const categories = new Set(TEMPLATES.map(t => t.category));
      expect(categories.size).toBe(4);
      expect(categories.has('network')).toBe(true);
      expect(categories.has('file')).toBe(true);
      expect(categories.has('process')).toBe(true);
      expect(categories.has('system')).toBe(true);
    });

    it('should have valid template structure', () => {
      TEMPLATES.forEach(template => {
        expect(template.id).toBeTruthy();
        expect(template.name).toBeTruthy();
        expect(template.category).toBeTruthy();
        expect(template.template).toBeTruthy();
        expect(template.description).toBeTruthy();
      });
    });
  });

  describe('getTemplatesByCategory', () => {
    it('should return network templates', () => {
      const networkTemplates = getTemplatesByCategory('network');
      expect(networkTemplates.length).toBeGreaterThan(0);
      networkTemplates.forEach(t => {
        expect(t.category).toBe('network');
      });
    });

    it('should return file templates', () => {
      const fileTemplates = getTemplatesByCategory('file');
      expect(fileTemplates.length).toBeGreaterThan(0);
      fileTemplates.forEach(t => {
        expect(t.category).toBe('file');
      });
    });

    it('should return process templates', () => {
      const processTemplates = getTemplatesByCategory('process');
      expect(processTemplates.length).toBeGreaterThan(0);
      processTemplates.forEach(t => {
        expect(t.category).toBe('process');
      });
    });

    it('should return system templates', () => {
      const systemTemplates = getTemplatesByCategory('system');
      expect(systemTemplates.length).toBeGreaterThan(0);
      systemTemplates.forEach(t => {
        expect(t.category).toBe('system');
      });
    });
  });

  describe('getCategoryName', () => {
    it('should return correct category names', () => {
      expect(getCategoryName('network')).toBe('Network');
      expect(getCategoryName('file')).toBe('File Operations');
      expect(getCategoryName('process')).toBe('Process Management');
      expect(getCategoryName('system')).toBe('System Info');
    });
  });

  describe('fillTemplate', () => {
    it('should replace single parameter', () => {
      const template = 'ping -c 4 {{host}}';
      const values = { host: 'google.com' };
      const result = fillTemplate(template, values);
      expect(result).toBe('ping -c 4 google.com');
    });

    it('should replace multiple parameters', () => {
      const template = 'tar -czf {{filename}}.tar.gz {{directory}}';
      const values = { filename: 'backup', directory: '/home/user' };
      const result = fillTemplate(template, values);
      expect(result).toBe('tar -czf backup.tar.gz /home/user');
    });

    it('should handle templates with no parameters', () => {
      const template = 'df -h';
      const values = {};
      const result = fillTemplate(template, values);
      expect(result).toBe('df -h');
    });

    it('should replace multiple occurrences of same parameter', () => {
      const template = 'echo {{value}} and {{value}}';
      const values = { value: 'test' };
      const result = fillTemplate(template, values);
      expect(result).toBe('echo test and test');
    });
  });

  describe('specific templates', () => {
    it('should have ping template with correct structure', () => {
      const ping = TEMPLATES.find(t => t.id === 'net-ping');
      expect(ping).toBeDefined();
      expect(ping?.template).toBe('ping -c 4 {{host}}');
      expect(ping?.parameters).toEqual(['host']);
    });

    it('should have tar template with correct structure', () => {
      const tar = TEMPLATES.find(t => t.id === 'file-tar');
      expect(tar).toBeDefined();
      expect(tar?.template).toBe('tar -czf {{filename}}.tar.gz {{directory}}');
      expect(tar?.parameters).toEqual(['filename', 'directory']);
    });

    it('should have df template with no parameters', () => {
      const df = TEMPLATES.find(t => t.id === 'sys-df');
      expect(df).toBeDefined();
      expect(df?.template).toBe('df -h');
      expect(df?.parameters).toBeUndefined();
    });
  });
});
