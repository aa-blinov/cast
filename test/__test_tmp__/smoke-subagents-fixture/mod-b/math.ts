/** Intentional bug for review smoke: divides by zero when b===0. */
export function divide(a: number, b: number): number {
	return a / b;
}
