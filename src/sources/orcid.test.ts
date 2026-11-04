import assert from "node:assert/strict";
import { currentEmployments } from "./orcid.ts";

// Only entries without an end date count, newest start first; the shape
// follows pub.orcid.org/v3.0/<id>/employments.
const summary = (name: string, start: number | null, end: number | null, role = "") => ({
	"employment-summary": {
		organization: { name },
		"role-title": role || null,
		"start-date": start === null ? null : { year: { value: String(start) } },
		"end-date": end === null ? null : { year: { value: String(end) } },
	},
});
const data = {
	"affiliation-group": [
		{ summaries: [summary("Universitat de Barcelona", 2025, null, "Associate Professor")] },
		{ summaries: [summary("Universitat de Barcelona", 2021, 2025, "Lecturer")] },
		{ summaries: [summary("Second Place", null, null)] },
	],
};
assert.deepEqual(currentEmployments(data), [
	{ organization: "Universitat de Barcelona", role: "Associate Professor", since: 2025 },
	{ organization: "Second Place", role: "", since: null },
]);
assert.deepEqual(currentEmployments({}), []);
assert.deepEqual(currentEmployments(null), []);
console.log("orcid.test.ts: all assertions passed");
