import { Plugin, WorkspaceLeaf } from 'obsidian';
import TaskGraphView from 'TasksGraphView';

export default class TaskGraphPlugin extends Plugin {
  async onload() {
    this.registerView('task-graph', leaf => {
        const view = new TaskGraphView(leaf, this.app)
        return view;
    });
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
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType('task-graph')[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: 'task-graph', active: true });
      }
    }
    if (leaf) {
      this.app.workspace.revealLeaf(leaf);
    }
  }
}
