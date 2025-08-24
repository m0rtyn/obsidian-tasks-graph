import { COLORS } from "colors";
import * as d3 from "d3";
import { ItemView, WorkspaceLeaf, App, TFile } from "obsidian";
import { TaskNode, TaskLink, Task } from "types";

const { cyan: c, yellow: y, green: g, orange: o, blue: b, red: r, darkGreen: dg } = COLORS

export default class TaskGraphView extends ItemView {
  private data: { nodes: TaskNode[]; links: TaskLink[] } = { nodes: [], links: [] };
  private simulation: d3.Simulation<TaskNode, TaskLink> | null = null;
  private zoom: d3.ZoomBehavior<HTMLCanvasElement, unknown> | null = null;
  private canvas: d3.Selection<HTMLCanvasElement, unknown, null, undefined> | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private showCompleted = true;
  private showBlocked = true;
  private liveUpdate = true;
  private showWithoutTags = false;
  private useDates = false;
  private fileEventRef: any = null;
  private allTags = new Set<string>();
  private selectedTags = new Set<string>();
  private tagsMenuVisible = false;
  private taskLimit = 500;

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

  async onClose() {
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
      if (tasks.length >= this.taskLimit) break;
      const cache = this.app.metadataCache.getFileCache(file);
      const lines = (await this.app.vault.read(file)).split('\n');
      const stack: { task: Task; indent: number }[] = [];
      lines.forEach((line, i) => {
        if (tasks.length >= this.taskLimit) return;
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

        const listItems = cache?.listItems;
        const listItem = listItems?.find(item => item.position.start.line === i);
        const blockId = listItem?.id;

        const task: Task = {
          id: idM ? idM[1] : `task-${file.path}-${i}`,
          text, completed, children: [], parent: null,
          blockers: blockerMs.map(x => x[1]),
          file: file.path, line: i, depth: 0,
          tags, scheduled, start,
          outlinks: cache?.links?.map(l => ({ subpath: l.link })),
          blockId,
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
    const wantTasks = new Set<string>();
    const wantTaskBlockIds = new Set<string>();
    tasks.forEach(t => {
      if (t.tags.includes('#want')) {
        wantTasks.add(t.id);
        if (t.blockId) {
          wantTaskBlockIds.add(t.blockId);
        }
      }
    });

    const linkedTasks = new Set<string>();
    tasks.forEach(t => {
      if (t.outlinks) {
        for (const link of t.outlinks) {
          if (wantTaskBlockIds.has(link.subpath.slice(1))) {
            linkedTasks.add(t.id);
            break;
          }
        }
      }
    });

    const nodes: TaskNode[] = [];
    const links: TaskLink[] = [];
    const allIds = new Set<string>();
    tasks.forEach(t => allIds.add(t.id));

    const filteredTasks = tasks.filter(t => wantTasks.has(t.id) || linkedTasks.has(t.id));

    filteredTasks.forEach(t => {
      nodes.push({ ...t, text: t.completed ? `✅ ${t.text}` : t.text });
    });

    const visible = new Set(nodes.map(n => n.id));

    filteredTasks.forEach(t => {
      if (t.parent && visible.has(t.parent)) {
        links.push({ source: t.parent, target: t.id, type: 'hierarchy' });
      }
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

    const limitLabel = ctr.createEl('label', { cls: 'task-graph-control-label', text: 'Task limit:' });
    const limitInput = limitLabel.createEl('input', { type: 'number', cls: 'task-graph-control-input' });
    limitInput.value = this.taskLimit.toString();
    limitInput.style.width = '60px';
    limitInput.addEventListener('change', () => {
        const limit = parseInt(limitInput.value, 10);
        if (!isNaN(limit)) {
            this.taskLimit = limit;
            this.refreshData();
        }
    });

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

    const w = c.clientWidth, h = c.clientHeight;
    this.canvas = d3.select(c).append('canvas').attr('width', w).attr('height', h);
    this.context = this.canvas.node()!.getContext('2d');
    if (!this.context) return;

    const validLinks = this.data.links.filter(l =>
      this.data.nodes.some(n => n.id === l.source) &&
      this.data.nodes.some(n => n.id === l.target)
    );

    this.zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.1, 5])
      .on('zoom', e => {
        this.context!.save();
        this.context!.clearRect(0, 0, w, h);
        this.context!.translate(e.transform.x, e.transform.y);
        this.context!.scale(e.transform.k, e.transform.k);
        this.draw(e.transform);
        this.context!.restore();
      });

    this.canvas.call(this.zoom);

    this.simulation = d3.forceSimulation<TaskNode>(this.data.nodes)
      .force('link', d3.forceLink<TaskNode, TaskLink>(validLinks).id(d => d.id).distance(d => d.type === 'hierarchy' ? 80 : 120).strength(0.1))
      .force('charge', d3.forceManyBody<TaskNode>().strength(-50))
      .force('center', d3.forceCenter(w / 2, h / 2))
      .force('collision', d3.forceCollide<TaskNode>().radius(30).strength(0.2));

    this.simulation.on('tick', () => {
      if (!this.context) return;
      this.context.save();
      this.context.clearRect(0, 0, w, h);
      const transform = d3.zoomTransform(this.canvas!.node()!);
      this.context.translate(transform.x, transform.y);
      this.context.scale(transform.k, transform.k);
      this.draw(transform);
      this.context.restore();
    });
  }

  private draw(transform: d3.ZoomTransform) {
    if (!this.context) return;
    const ctx = this.context;
    const { width, height } = this.canvas!.node()!;
    const visibleWidth = width / transform.k;
    const visibleHeight = height / transform.k;
    const visibleX = -transform.x / transform.k;
    const visibleY = -transform.y / transform.k;

    // Draw links
    this.data.links.forEach(d => {
      const source = d.source as unknown as TaskNode;
      const target = d.target as unknown as TaskNode;
      if (
        (source.x! < visibleX || source.x! > visibleX + visibleWidth || source.y! < visibleY || source.y! > visibleY + visibleHeight) &&
        (target.x! < visibleX || target.x! > visibleX + visibleWidth || target.y! < visibleY || target.y! > visibleY + visibleHeight)
      ) return;
      ctx.beginPath();
      ctx.moveTo(source.x!, source.y!);
      ctx.lineTo(target.x!, target.y!);
      ctx.strokeStyle = d.type === 'dependency' ? r : b;
      ctx.lineWidth = 2;
      if (d.type === 'dependency') {
        ctx.setLineDash([5, 5]);
      } else {
        ctx.setLineDash([]);
      }
      ctx.stroke();
    });

    // Draw nodes
    this.data.nodes.forEach(d => {
      if (d.x! < visibleX || d.x! > visibleX + visibleWidth || d.y! < visibleY || d.y! > visibleY + visibleHeight) return;
      const radius = 25 - d.depth * 3;
      if (transform.k < 0.5) {
        ctx.beginPath();
        ctx.arc(d.x!, d.y!, radius / 2, 0, 2 * Math.PI);
        ctx.fillStyle = d.blockers.length ? o : d.depth === 0 ? g : d.children.length ? y : c;
        ctx.fillStyle = d.blockers.length ? o : d.depth === 0 ? g : d.children.length ? y : c;
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(d.x!, d.y!, radius, 0, 2 * Math.PI);
        ctx.fillStyle = d.blockers.length ? o : d.depth === 0 ? g : d.children.length ? y : c;
        ctx.fill();
        ctx.strokeStyle = d.depth === 0 ? dg : '#888';
        ctx.lineWidth = d.depth === 0 ? 2 : 1;
        ctx.stroke();

        ctx.fillStyle = '#333';
        ctx.font = `${d.depth === 0 ? 12 : 10}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const text = d.text.length > 20 ? `${d.text.slice(0,17)}…` : d.text;
        ctx.fillText(text, d.x!, d.y! + 5);
      }
    });
  }

  private updateGraph() {
    if (!this.simulation) {
      this.renderGraph();
      return;
    }

    const validLinks = this.data.links.filter(l =>
      this.data.nodes.some(n => n.id === l.source) &&
      this.data.nodes.some(n => n.id === l.target)
    );

    this.simulation.nodes(this.data.nodes);
    this.simulation.force<d3.ForceLink<TaskNode, TaskLink>>('link')!.links(validLinks);
    this.simulation.alpha(0.3).restart();
  }

  private drag(sim: d3.Simulation<TaskNode, undefined>) {
    const started = (e: d3.D3DragEvent<HTMLCanvasElement, TaskNode, TaskNode>, d: TaskNode) => {
      if (!e.active) sim.alphaTarget(0.3).restart();
      d.fx = d.x; d.fy = d.y;
    };
    const dragged = (e: d3.D3DragEvent<HTMLCanvasElement, TaskNode, TaskNode>, d: TaskNode) => {
      d.fx = e.x; d.fy = e.y;
    };
    const ended = (e: d3.D3DragEvent<HTMLCanvasElement, TaskNode, TaskNode>, d: TaskNode) => {
      if (!e.active) sim.alphaTarget(0);
      d.fx = null; d.fy = null;
    };

    return d3.drag<HTMLCanvasElement, TaskNode>()
      .subject((event, d) => {
        const node = this.findNode(event.x, event.y);
        return node || d;
      })
      .on('start', started)
      .on('drag', dragged)
      .on('end', ended);
  }

  private findNode(x: number, y: number): TaskNode | undefined {
    const transform = d3.zoomTransform(this.canvas!.node()!);
    const xt = transform.invertX(x);
    const yt = transform.invertY(y);
    for (const node of this.data.nodes) {
      const dx = xt - node.x!;
      const dy = yt - node.y!;
      if (dx * dx + dy * dy < (25 - node.depth * 3) ** 2) {
        return node;
      }
    }
  }

  private fitToView() {
    if (!this.canvas || !this.data.nodes.length) return;
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
    const tx = w / 2 - scale * (minX + graphW / 2);
    const ty = h / 2 - scale * (minY + graphH / 2);
    const transform = d3.zoomIdentity.translate(tx, ty).scale(scale);
    this.canvas.transition().duration(500).call(this.zoom!.transform, transform);
  }
}
