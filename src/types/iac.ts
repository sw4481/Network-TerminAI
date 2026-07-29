export type IaCTool = 'terraform' | 'ansible';

export type ResourceAction =
  | 'Create'
  | 'Update'
  | 'Destroy'
  | 'Ok'
  | 'Changed'
  | 'Skipped'
  | 'Failed';

export interface ResourceEvent {
  resourceType: string;
  resourceName: string;
  resourceId?: string;
  action: ResourceAction;
  timestamp: number;
  durationMs?: number;
  error?: string;
}

export interface IaCMetadata {
  resourcesChanged: number;
  resourcesFailed: number;
  resourceEvents: ResourceEvent[];
  summary: string;
}

export interface IaCExecution {
  id: string;
  commandBlockId: string;
  tool: IaCTool;
  subcommand: string;
  projectPath: string;
  gitCommit?: string;
  gitBranch?: string;
  hadUncommittedChanges: boolean;
  blastRadius?: 'low' | 'medium' | 'high' | 'critical';
  resourcesChanged?: number;
  resourcesFailed?: number;
  metadataJson?: string;
  createdAt: number;
}

export interface ParsedIaCMetadata extends IaCExecution {
  metadata: IaCMetadata;
}

export function parseIaCExecution(exec: IaCExecution): ParsedIaCMetadata | null {
  if (!exec.metadataJson) {
    return null;
  }

  try {
    const metadata: IaCMetadata = JSON.parse(exec.metadataJson);
    return {
      ...exec,
      metadata,
    };
  } catch (e) {
    console.error('Failed to parse IaC metadata:', e);
    return null;
  }
}
