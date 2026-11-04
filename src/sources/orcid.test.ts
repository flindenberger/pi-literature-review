import assert from "node:assert/strict";
import { currentEmployments, orcidPeople } from "./orcid.ts";

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
// Expanded search: iD and name forms; e-mail fields never read.
assert.deepEqual(orcidPeople({ "expanded-result": [
	{ "orcid-id": "0009-0008-1759-3515", "given-names": "Florian", "family-names": "Lindenberger", "credit-name": null, "other-name": [], email: ["x@y"] },
	{ "orcid-id": "0000-0001-8248-5272", "given-names": "José", "family-names": "Arnáez", "other-name": ["José Arnáez-Vadillo"] },
] }), [
	{ orcid: "0009-0008-1759-3515", names: ["Florian Lindenberger"] },
	{ orcid: "0000-0001-8248-5272", names: ["José Arnáez", "José Arnáez-Vadillo"] },
]);
assert.deepEqual(orcidPeople({}), []);
console.log("orcid.test.ts: all assertions passed");
