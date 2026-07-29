import { useState, useEffect, useRef } from 'react';

export interface Parameter {
  name: string;
  required: boolean;
  type: 'text' | 'number' | 'select' | 'password';
  options?: string[];
  placeholder?: string;
  description?: string;
}

export interface CommandDefinition {
  command: string;
  description: string;
  parameters: Parameter[];
  buildCommand: (values: Record<string, string>) => string;
}

export const PARAMETER_DEFINITIONS: Record<string, CommandDefinition> = {
  ssh: {
    command: 'ssh',
    description: 'Connect to a remote host via SSH',
    parameters: [
      {
        name: 'host',
        required: true,
        type: 'text',
        placeholder: 'example.com or 192.168.1.1',
        description: 'Remote host address',
      },
      {
        name: 'user',
        required: false,
        type: 'text',
        placeholder: 'username',
        description: 'Username for authentication',
      },
      {
        name: 'port',
        required: false,
        type: 'number',
        placeholder: '22',
        description: 'SSH port (default: 22)',
      },
      {
        name: 'identity',
        required: false,
        type: 'text',
        placeholder: '~/.ssh/id_rsa',
        description: 'Path to identity file (private key)',
      },
      {
        name: 'password',
        required: false,
        type: 'password',
        placeholder: 'password',
        description: 'Password (leave empty for key-based auth)',
      },
    ],
    buildCommand: (values) => {
      let cmd = 'ssh';
      if (values.port) cmd += ` -p ${values.port}`;
      if (values.identity) cmd += ` -i ${values.identity}`;
      if (values.user && values.host) cmd += ` ${values.user}@${values.host}`;
      else if (values.host) cmd += ` ${values.host}`;
      return cmd;
    },
  },
  scp: {
    command: 'scp',
    description: 'Securely copy files between hosts',
    parameters: [
      {
        name: 'source',
        required: true,
        type: 'text',
        placeholder: 'local/file.txt or user@host:/path/file.txt',
        description: 'Source file path',
      },
      {
        name: 'destination',
        required: true,
        type: 'text',
        placeholder: 'user@host:/path/ or local/path/',
        description: 'Destination path',
      },
      {
        name: 'port',
        required: false,
        type: 'number',
        placeholder: '22',
        description: 'SSH port (default: 22)',
      },
      {
        name: 'recursive',
        required: false,
        type: 'select',
        options: ['yes', 'no'],
        description: 'Copy directories recursively',
      },
    ],
    buildCommand: (values) => {
      let cmd = 'scp';
      if (values.port) cmd += ` -P ${values.port}`;
      if (values.recursive === 'yes') cmd += ` -r`;
      cmd += ` ${values.source} ${values.destination}`;
      return cmd;
    },
  },
  find: {
    command: 'find',
    description: 'Search for files in directory hierarchy',
    parameters: [
      {
        name: 'path',
        required: true,
        type: 'text',
        placeholder: '/path/to/search',
        description: 'Starting directory for search',
      },
      {
        name: 'name',
        required: false,
        type: 'text',
        placeholder: '*.txt',
        description: 'File name pattern to match',
      },
      {
        name: 'type',
        required: false,
        type: 'select',
        options: ['f', 'd', 'l'],
        description: 'Type: f=file, d=directory, l=symlink',
      },
      {
        name: 'maxdepth',
        required: false,
        type: 'number',
        placeholder: '3',
        description: 'Maximum directory depth',
      },
    ],
    buildCommand: (values) => {
      let cmd = `find ${values.path}`;
      if (values.maxdepth) cmd += ` -maxdepth ${values.maxdepth}`;
      if (values.type) cmd += ` -type ${values.type}`;
      if (values.name) cmd += ` -name "${values.name}"`;
      return cmd;
    },
  },
  grep: {
    command: 'grep',
    description: 'Search text patterns in files',
    parameters: [
      {
        name: 'pattern',
        required: true,
        type: 'text',
        placeholder: 'search pattern',
        description: 'Pattern to search for',
      },
      {
        name: 'file',
        required: false,
        type: 'text',
        placeholder: 'file.txt',
        description: 'File to search in',
      },
      {
        name: 'recursive',
        required: false,
        type: 'select',
        options: ['yes', 'no'],
        description: 'Search recursively in directories',
      },
      {
        name: 'ignoreCase',
        required: false,
        type: 'select',
        options: ['yes', 'no'],
        description: 'Ignore case distinctions',
      },
    ],
    buildCommand: (values) => {
      let cmd = 'grep';
      if (values.ignoreCase === 'yes') cmd += ' -i';
      if (values.recursive === 'yes') cmd += ' -r';
      cmd += ` "${values.pattern}"`;
      if (values.file) cmd += ` ${values.file}`;
      return cmd;
    },
  },
  curl: {
    command: 'curl',
    description: 'Transfer data from or to a server',
    parameters: [
      {
        name: 'url',
        required: true,
        type: 'text',
        placeholder: 'https://api.example.com/endpoint',
        description: 'URL to request',
      },
      {
        name: 'method',
        required: false,
        type: 'select',
        options: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
        description: 'HTTP method',
      },
      {
        name: 'data',
        required: false,
        type: 'text',
        placeholder: '{"key": "value"}',
        description: 'Request body data',
      },
      {
        name: 'header',
        required: false,
        type: 'text',
        placeholder: 'Authorization: Bearer token',
        description: 'HTTP header to include',
      },
    ],
    buildCommand: (values) => {
      let cmd = 'curl';
      if (values.method && values.method !== 'GET') cmd += ` -X ${values.method}`;
      if (values.header) cmd += ` -H "${values.header}"`;
      if (values.data) cmd += ` -d '${values.data}'`;
      cmd += ` "${values.url}"`;
      return cmd;
    },
  },
};

const SHOW_DELAY_MS = 500;

export function useParameterDetection(input: string) {
  const [commandDef, setCommandDef] = useState<CommandDefinition | null>(null);
  const [shouldShow, setShouldShow] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Clear existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    // Reset state
    setShouldShow(false);

    // Check if input matches a command that needs parameters
    // Don't trim - we need to detect trailing whitespace
    const endsWithSpace = input.endsWith(' ');
    const trimmed = input.trim();
    const parts = trimmed.split(/\s+/);
    const command = parts[0];

    // Check if this is a supported command followed by whitespace
    if (endsWithSpace && command && PARAMETER_DEFINITIONS[command]) {
      const def = PARAMETER_DEFINITIONS[command];
      setCommandDef(def);

      // Set timeout to show form after delay
      timeoutRef.current = setTimeout(() => {
        setShouldShow(true);
      }, SHOW_DELAY_MS);
    } else {
      setCommandDef(null);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [input]);

  return {
    commandDef,
    shouldShow,
  };
}
