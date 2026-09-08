export function contextInject(query: string, context: string): string {
    return context + "\n" + query
}
