import { App, Plugin, WorkspaceLeaf, ItemView, TFile } from 'obsidian';
import * as d3 from 'd3';

interface Task {
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
}

interface TaskNode extends Task {
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
}

interface TaskLink {
  source: string;
  target: string;
  type: 'dependency' | 'hierarchy';
}

class TaskGraphView extends ItemView {
  private data: { nodes: TaskNode[]; links: TaskLink[] } = { nodes: [], links: [] };
  private simulation: d3.Simulation<TaskNode, TaskLink> | null = null;
  private zoom: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
  private svg: d3.Selection<SVGSVGElement, unknown, HTMLElement, any> | null = null;
  private graphGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any> | null = null;
  private showCompleted = true;
  private showBlocked = true;
  private liveUpdate = true;
  private showWithoutTags = false;
  private useDates = false;
  private fileEventRef: any = null;
  private allTags = new Set<string>();
  private selectedTags = new Set<string>();
  private tagsMenuVisible = false;

  constructor(leaf: WorkspaceLeaf, app: App) {
    super(leaf);
    this.app = app;
  }

  getViewType() { return 'task-graph'; }
  getDisplayText() { return 'Task Dependency Graph'; }

  async onOpen() {
    await this.collectTasks();
    this.renderGraph();
    this.setupFileWatch();
  }

  onClose() {
    if (this.fileEventRef) {
      this.app.vault.offref(this.fileEventRef);
      this.fileEventRef = null;
    }
    this.simulation?.stop();
  }

  private setupFileWatch() {
    if (this.fileEventRef) {
      this.app.vault.offref(this.fileEventRef);
    }
    if (this.liveUpdate) {
      this.fileEventRef = this.app.vault.on('modify', file => {
        if (file instanceof TFile && file.extension === 'md') {
          this.refreshData();
        }
      });
    }
  }

  private async refreshData() {
    await this.collectTasks();
    this.updateGraph();
  }

  private async collectTasks() {
    const tasks: Task[] = [];
    this.allTags.clear();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const lines = (await this.app.vault.read(file)).split('\n');
      const stack: { task: Task; indent: number }[] = [];
      lines.forEach((line, i) => {
        const trimmed = line.trimStart();
        const indent = line.length - trimmed.length;
        const m = trimmed.match(/^- \[(.)\]\s*(.+)$/);
        if (!m) return;
        const completed = m[1] !== ' ';
        let text = m[2];

        // tags
        const tagMatches = text.match(/#\S+/g) || [];
        const tags = Array.from(new Set(tagMatches.map(t => t.toLowerCase())));
        text = text.replace(/#\S+/g, '').trim();
        tags.forEach(t => this.allTags.add(t));

        // ID & blockers
        const idM = text.match(/🆔\s*(\S+)/);
        const blockerMs = [...text.matchAll(/⛔\s*(\S+)/g)];
        text = text.replace(/🆔\s*\S+|⛔\s*\S+/g, '').trim();

        // Dates
        const schedM = text.match(/⏳\s*(\d{4}-\d{2}-\d{2})/);
        const startM = text.match(/🛫\s*(\d{4}-\d{2}-\d{2})/);
        const scheduled = schedM ? new Date(schedM[1]) : null;
        const start = startM ? new Date(startM[1]) : null;
        text = text
          .replace(/⏳\s*\d{4}-\d{2}-\d{2}/g, '')
          .replace(/🛫\s*\d{4}-\d{2}-\d{2}/g, '')
          .trim();

        const task: Task = {
          id: idM ? idM[1] : `task-${file.path}-${i}`,
          text, completed, children: [], parent: null,
          blockers: blockerMs.map(x => x[1]),
          file: file.path, line: i, depth: 0,
          tags, scheduled, start,
        };

        while (stack.length && stack[stack.length - 1].indent >= indent) {
          stack.pop();
        }
        if (stack.length) {
          task.parent = stack[stack.length - 1].task.id;
          task.depth = stack[stack.length - 1].task.depth + 1;
          stack[stack.length - 1].task.children.push(task);
        }
        stack.push({ task, indent });
        tasks.push(task);
      });
    }
    this.processTasks(tasks);
  }

  private processTasks(tasks: Task[]) {
    const nodes: TaskNode[] = [];
    const links: TaskLink[] = [];
    const allIds = new Set<string>();
    tasks.filter(t => !t.parent).forEach(t => {
      (function collect(u: Task) { allIds.add(u.id); u.children.forEach(collect); })(t);
    });

    const create = (t: Task) => {
      const isBlocked = t.blockers.length > 0;
      const hasTag = this.selectedTags.size > 0 && t.tags.some(tag => this.selectedTags.has(tag));
      const noTags = this.showWithoutTags && t.tags.length === 0;
      const tagOk = (this.selectedTags.size === 0 && !this.showWithoutTags) || hasTag || noTags;
      if ((this.showCompleted || !t.completed) && (this.showBlocked || !isBlocked) && tagOk) {
        nodes.push({ ...t, text: t.completed ? `✅ ${t.text}` : t.text });
      }
      t.children.forEach(c => {
        const cb = c.blockers.length > 0;
        if ((this.showCompleted || (!t.completed && !c.completed)) && (this.showBlocked || (!isBlocked && !cb))) {
          links.push({ source: t.id, target: c.id, type: 'hierarchy' });
        }
        create(c);
      });
    };
    tasks.filter(t => !t.parent).forEach(create);

    const visible = new Set(nodes.map(n => n.id));
    tasks.forEach(t => {
      if (!this.showBlocked && t.blockers.length) return;
      t.blockers.forEach(b => {
        if (allIds.has(b) && visible.has(b) && visible.has(t.id)) {
          links.push({ source: b, target: t.id, type: 'dependency' });
        }
      });
    });

    this.data = { nodes, links };
  }

  private async openTaskInEditor(node: TaskNode, inNew = false) {
    const file = this.app.vault.getAbstractFileByPath(node.file);
    if (!(file instanceof TFile)) return;

    let leaf: WorkspaceLeaf;
    if (inNew) {
      leaf = this.app.workspace.splitActiveLeaf();
    } else {
      const mdLeaves = this.app.workspace.getLeavesOfType('markdown');
      leaf = mdLeaves.length > 0 ? mdLeaves[0] : this.app.workspace.getLeaf(false);
    }

    await leaf.openFile(file, { active: true });
    setTimeout(() => {
      const editor = (leaf.view as any).editor;
      if (!editor) return;
      editor.setCursor({ line: node.line, ch: 0 });
      editor.scrollIntoView({
        from: { line: Math.max(0, node.line - 5), ch: 0 },
        to:   { line: node.line + 5, ch: 0 }
      }, true);
    }, 100);
  }

  renderControls(container: HTMLElement) {
    const ctr = container.createDiv('task-graph-controls');
    Object.assign(ctr.style, {
      position: 'absolute', top: '10px', left: '10px', zIndex: '10',
      display: 'flex', gap: '10px', flexWrap: 'wrap',
      backgroundColor: 'var(--background-primary)', padding: '8px',
      borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
    });

    const mkToggle = (labelText: string, initial: boolean, onChange: (v: boolean) => void) => {
      const lbl = ctr.createEl('label', { cls: 'task-graph-control-label', text: labelText });
      const inp = lbl.createEl('input', { type: 'checkbox', cls: 'task-graph-control-toggle' });
      inp.checked = initial;
      inp.addEventListener('change', () => onChange(inp.checked));
      return lbl;
    };

    mkToggle('Show completed:', this.showCompleted, v => { this.showCompleted = v; this.refreshData(); });
    mkToggle('Show blocked:'  , this.showBlocked  , v => { this.showBlocked   = v; this.refreshData(); });
    mkToggle('Live update:'   , this.liveUpdate   , v => { this.liveUpdate    = v; this.setupFileWatch(); });
    mkToggle('Use Dates:'     , this.useDates     , v => { this.useDates      = v; this.refreshData(); });

    const updateBtn = ctr.createEl('button', { text: '🔄 Update', cls: 'task-graph-control-button' });
    updateBtn.addEventListener('click', () => this.refreshData());
    const fitBtn = ctr.createEl('button', { text: '🔍 Fit to view', cls: 'task-graph-control-button' });
    fitBtn.addEventListener('click', () => this.fitToView());

    const tagsBtn = ctr.createEl('button', { text: '🏷️ Tags', cls: 'task-graph-control-button' });
    tagsBtn.addEventListener('click', () => {
      this.tagsMenuVisible = !this.tagsMenuVisible;
      tagsContainer.style.display = this.tagsMenuVisible ? 'block' : 'none';
    });

    const tagsContainer = container.createDiv('task-graph-tags-container');
    Object.assign(tagsContainer.style, {
      position: 'absolute', top: '50px', left: '10px', zIndex: '20',
      backgroundColor: 'var(--background-primary)', padding: '10px',
      borderRadius: '4px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
      maxHeight: '300px', overflowY: 'auto',
      display: this.tagsMenuVisible ? 'block' : 'none'
    });
    tagsContainer.createEl('h4', { text: 'Filter by Tags', cls: 'task-graph-tags-header' });

    const noTagLbl = tagsContainer.createEl('label', { cls: 'task-graph-tags-label', text: 'without tags' });
    Object.assign(noTagLbl.style, { display: 'flex', marginBottom: '8px' });
    const noTagChk = noTagLbl.createEl('input', { type: 'checkbox', cls: 'task-graph-tags-checkbox' });
    noTagChk.checked = this.showWithoutTags;
    noTagChk.addEventListener('click', e => e.stopPropagation());
    noTagChk.addEventListener('change', () => {
      this.showWithoutTags = noTagChk.checked;
      this.refreshData();
      this.tagsMenuVisible = true;
      tagsContainer.style.display = 'block';
    });

    const clearBtn = tagsContainer.createEl('button', { text: 'Clear All', cls: 'task-graph-tags-clear' });
    Object.assign(clearBtn.style, { width: '100%', marginBottom: '10px' });
    clearBtn.addEventListener('click', () => {
      this.selectedTags.clear();
      this.showWithoutTags = false;
      this.refreshData();
      tagsContainer.querySelectorAll('input[type="checkbox"]').forEach((cb: HTMLInputElement) => cb.checked = false);
    });

    if (this.allTags.size) {
      Array.from(this.allTags).sort().forEach(tag => {
        const lbl = tagsContainer.createEl('label', { cls: 'task-graph-tags-label', text: tag });
        lbl.style.display = 'block';
        const cb = lbl.createEl('input', { type: 'checkbox', cls: 'task-graph-tags-checkbox' });
        cb.checked = this.selectedTags.has(tag);
        cb.addEventListener('click', e => e.stopPropagation());
        cb.addEventListener('change', () => {
          if (cb.checked) this.selectedTags.add(tag);
          else            this.selectedTags.delete(tag);
          this.refreshData();
          this.tagsMenuVisible = true;
          tagsContainer.style.display = 'block';
        });
      });
    } else {
      tagsContainer.createEl('p', { text: 'No tags found in tasks', cls: 'task-graph-tags-empty' });
    }
  }

  renderGraph() {
    const c = this.containerEl.children[1] as HTMLElement;
    c.empty();
    c.style.position = 'relative';
    c.style.overflow = 'hidden';
    this.renderControls(c);

    this.svg = d3.select(c).append('svg').attr('width', '100%').attr('height', '100%');
    this.graphGroup = this.svg.append('g');
    const w = c.clientWidth, h = c.clientHeight;

    const validLinks = this.data.links.filter(l =>
      this.data.nodes.some(n => n.id === l.source) &&
      this.data.nodes.some(n => n.id === l.target)
    );

    // Zoom with wheel, pan with right mouse button
    this.zoom = d3.zoom<SVGSVGElement, unknown>()
      .filter((event: any) => {
        if (event.type === 'wheel') return true; // Allow zoom with mouse wheel
        if (event.type === 'mousedown' && event.button === 2) return true; // Allow pan with RMB
        return false; // Block LMB for zoom/pan to allow node dragging
      })
      .scaleExtent([0.1, 5])
      .on('zoom', e => this.graphGroup!.attr('transform', e.transform));

    this.svg
      .call(this.zoom)
      .on('contextmenu', (event: any) => event.preventDefault());

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const leftX = w * 0.25, midX = w * 0.5, rightX = w * 0.75;

    this.simulation = d3.forceSimulation<TaskNode>(this.data.nodes)
      .force('link', d3.forceLink<TaskNode, TaskLink>(validLinks).id(d => d.id).distance(d => d.type === 'hierarchy' ? 100 : 150))
      .force('charge', d3.forceManyBody<TaskNode>().strength(d => d.depth === 0 ? -300 : -100))
      .force('x', d3.forceX<TaskNode>(d => {
        if (!this.useDates) return midX;
        const dt = d.start || d.scheduled;
        if (dt) {
          const dd = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
          if (dd < today) return leftX;
          if (dd > today) return rightX;
        }
        return midX;
      }))
      .force('y', d3.forceY(h / 2))
      .force('collision', d3.forceCollide<TaskNode>().radius(40));

    const roots = this.data.nodes.filter(n => n.depth === 0);
    if (roots.length) {
      const step = 2 * Math.PI / roots.length, r = Math.min(w, h) * 0.3;
      roots.forEach((n, i) => {
        n.x = w / 2 + r * Math.cos(step * i);
        n.y = h / 2 + r * Math.sin(step * i);
      });
    }

    const link = this.graphGroup.append('g').selectAll('line')
      .data(validLinks).join('line')
      .attr('stroke', d => d.type === 'dependency' ? '#ff5555' : '#4a90e2')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', d => d.type === 'dependency' ? '5,5' : '0')
      .attr('marker-end', d => d.type === 'dependency' ? 'url(#arrowhead)' : null);

    this.svg.append('defs').append('marker')
      .attr('id', 'arrowhead').attr('viewBox', '-0 -5 10 10')
      .attr('refX', 25).attr('refY', 0).attr('orient', 'auto')
      .attr('markerWidth', 8).attr('markerHeight', 8)
      .append('svg:path').attr('d', 'M 0,-5 L 10,0 L 0,5').attr('fill', '#ff5555');

    const node = this.graphGroup.append('g').selectAll('g')
      .data(this.data.nodes).join('g')
      .call(this.drag(this.simulation!) as any)
      .on('dblclick', (e, d) => {
        e.preventDefault(); e.stopPropagation();
        this.openTaskInEditor(d, false);
      })
      .on('mousedown', (e, d) => {
        if (e.button === 1) {
          e.preventDefault(); e.stopPropagation();
          this.openTaskInEditor(d, true);
        }
      });

    node.append('circle')
      .attr('r', d => 25 - d.depth * 3)
      .attr('fill', d => d.blockers.length ? '#F7BB4B' : d.depth === 0 ? '#66E45F' : d.children.length ? '#ffdd99' : '#46E6FF')
      .attr('stroke', d => d.depth === 0 ? '#3c9133' : '#888')
      .attr('stroke-width', d => d.depth === 0 ? 2 : 1)
      .attr('opacity', d => d.completed && !this.showCompleted ? 0 : 1);

    node.append('text')
      .attr('text-anchor', 'middle').attr('dy', 5)
      .attr('font-size', d => d.depth === 0 ? 12 : 10)
      .attr('fill', '#333')
      .text(d => d.text.length > 20 ? `${d.text.slice(0,17)}…` : d.text)
      .attr('opacity', d => d.completed && !this.showCompleted ? 0 : 1);

    node.append('title').text(d => {
      let info = `${d.text}\nFile: ${d.file}\nLine: ${d.line+1}\nStatus: ${d.completed ? 'Completed' : 'Pending'}`;
      if (d.tags.length)    info += `\nTags: ${d.tags.join(', ')}`;
      if (d.scheduled)      info += `\n⏳ ${d.scheduled.toISOString().slice(0,10)}`;
      if (d.start)          info += `\n🛫 ${d.start.toISOString().slice(0,10)}`;
      return info;
    });

    this.simulation.on('tick', () => {
      link
        .attr('x1', d => (d.source as TaskNode).x || 0)
        .attr('y1', d => (d.source as TaskNode).y || 0)
        .attr('x2', d => (d.target as TaskNode).x || 0)
        .attr('y2', d => (d.target as TaskNode).y || 0);
      node.attr('transform', d => `translate(${d.x||0},${d.y||0})`);
    });

    this.simulation.on('end', () => setTimeout(() => this.fitToView(), 100));
  }

  private updateGraph() {
    this.renderGraph();
  }

  private drag(sim: d3.Simulation<TaskNode, undefined>) {
    const started = (e: d3.D3DragEvent<SVGGElement, TaskNode, TaskNode>, d: TaskNode) => {
      if (e.sourceEvent.button !== 0) return; // Only allow LMB for dragging
      if (!e.active) sim.alphaTarget(0.3).restart();
      d.fx = d.x; d.fy = d.y;
    };
    const dragged = (e: d3.D3DragEvent<SVGGElement, TaskNode, TaskNode>, d: TaskNode) => {
      d.fx = e.x; d.fy = e.y;
    };
    const ended = (e: d3.D3DragEvent<SVGGElement, TaskNode, TaskNode>, d: TaskNode) => {
      if (!e.active) sim.alphaTarget(0);
      d.fx = null; d.fy = null;
    };

    return d3.drag<SVGGElement, TaskNode>()
      .filter((event: any) => event.button === 0) // Only LMB for dragging
      .on('start', started)
      .on('drag', dragged)
      .on('end', ended);
  }

  private fitToView() {
    if (!this.svg || !this.graphGroup || !this.data.nodes.length) return;
    const c = this.containerEl.children[1] as HTMLElement;
    const w = c.clientWidth, h = c.clientHeight;
    const xs = this.data.nodes.map(d => d.x!).filter(x => !isNaN(x));
    const ys = this.data.nodes.map(d => d.y!).filter(y => !isNaN(y));
    if (!xs.length || !ys.length) return;
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const graphW = maxX - minX, graphH = maxY - minY;
    if (!graphW || !graphH) return;
    const scale = 0.85 / Math.max(graphW / w, graphH / h);
    const tx = w / 2 - scale * (minX + graphW / 2), ty = h / 2 - scale * (minY + graphH / 2);
    const transform = d3.zoomIdentity.translate(tx, ty).scale(scale);
    this.svg.transition().duration(500).call(this.zoom!.transform, transform);
  }
}

export default class TaskGraphPlugin extends Plugin {
  async onload() {
    this.registerView('task-graph', leaf => new TaskGraphView(leaf, this.app));
    this.addRibbonIcon('network', 'Show Task Graph', () => this.activateView());
    this.addCommand({
      id: 'show-task-graph',
      name: 'Show Tasks Graph',
      callback: () => this.activateView(),
    });

    const style = document.createElement('style');
    style.textContent = `
      .task-graph-controls { background: var(--background-primary); padding: 8px; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); z-index: 10; }
      .task-graph-control-button { background: var(--interactive-accent); color: white; border: none; border-radius: 4px; padding: 5px 10px; cursor: pointer; font-size: 14px; }
      .task-graph-control-button:hover { background: var(--interactive-accent-hover); }
      .task-graph-control-label { display: flex; align-items: center; gap: 5px; font-size: 14px; }
      .task-graph-control-toggle { margin: 0; }
      .task-graph-tags-container { background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-height: 300px; overflow-y: auto; padding: 12px; width: 250px; }
      .task-graph-tags-header { margin-top: 0; margin-bottom: 10px; font-size: 16px; color: var(--text-normal); }
      .task-graph-tags-label { display: flex; align-items: center; margin-bottom: 8px; font-size: 14px; color: var(--text-normal); }
      .task-graph-tags-checkbox { margin-right: 8px; }
      .task-graph-tags-clear { background: var(--interactive-accent); color: white; border: none; border-radius: 4px; padding: 5px 10px; cursor: pointer; font-size: 14px; margin-bottom: 10px; width: 100%; }
      .task-graph-tags-clear:hover { background: var(--interactive-accent-hover); }
      .task-graph-tags-empty { color: var(--text-muted); font-size: 14px; margin: 0; }
    `;
    document.head.appendChild(style);
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType('task-graph')[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: 'task-graph', active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }
}