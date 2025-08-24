export interface Task {
  id: string;
  text: string;
  completed: boolean;
  children: Task[];
  parent: string | null;
  blockers: string[];
  file: string;
  line: number;
  depth: number;
  tags: string[];
  scheduled: Date | null;
  start: Date | null;
  outlinks?: { subpath: string }[];
  blockId?: string;
}

export interface TaskNode extends Task {
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface TaskLink {
  source: string;
  target: string;
  type: 'dependency' | 'hierarchy';
}
