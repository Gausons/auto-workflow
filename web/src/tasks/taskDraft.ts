export function taskDraftContent(content: string, goal: string, planMode: boolean): string {
  return [content.trim(), goal.trim() ? `## 目标\n\n${goal.trim()}\n\n请围绕此目标推进任务，核对完成条件，并汇报已完成事项、验证结果和剩余阻碍。` : '',
    planMode ? '## 计划模式\n\n本轮仅分析需求、检查现有资料并制定可执行的计划；如有关键问题请先提问。不要修改项目文件、执行有副作用的命令或开始实施，等待用户确认计划后再执行。' : ''].filter(Boolean).join('\n\n');
}
