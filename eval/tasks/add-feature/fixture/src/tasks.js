export function activeTasks(tasks) {
    return tasks.filter((task) => !task.completed);
}
