// Example questions: prompt shape and the code checks, offline.
import assert from "node:assert/strict";
import { examplePaperName, examplesPrompt, parseExamples, sharedKeywords, type ExamplePaper } from "./examples.ts";

const luo: ExamplePaper = { name: "Luo et al. 2021", title: "An applicable and automatic method for earth surface water mapping", keywords: [] };
const isik: ExamplePaper = { name: "Isikdogan et al. 2017", title: "Surface Water Mapping by Deep Learning", keywords: ["convolutional neural networks", "Landsat", "remote sensing"] };

// Prompt: names for a small set, "these N papers" for a larger one.
assert.ok(examplesPrompt([luo, isik], false).includes("compare them by name"));
assert.ok(examplesPrompt([luo, isik], false).includes("Isikdogan et al. 2017: Surface Water Mapping by Deep Learning [keywords: convolutional neural networks; Landsat; remote sensing]"));
assert.ok(examplesPrompt(Array.from({ length: 5 }, () => isik), false).includes('"these 5 papers"'));
assert.ok(examplesPrompt([isik], true).includes('"it" or "this paper"'));
assert.deepEqual(sharedKeywords([isik, { ...luo, keywords: ["landsat", "lakes"] }]), ["Landsat"]);

// Checks: good questions pass, numbering and quotes are stripped.
assert.deepEqual(parseExamples("1. How do Luo et al. 2021 and Isikdogan et al. 2017 map surface water?\n- \"Which role do convolutional neural networks play here?\"\nWhat limitations of Landsat imagery do these papers discuss?", [luo, isik], false), [
	"How do Luo et al. 2021 and Isikdogan et al. 2017 map surface water?",
	"Which role do convolutional neural networks play here?",
	"What limitations of Landsat imagery do these papers discuss?",
]);
// A name, sensor or number the input does not hold fails the line.
assert.equal(parseExamples("Does Sentinel-2 beat Landsat in these papers?\nWhat accuracy above 95 percent is reported?\nHow is surface water mapped?", [luo, isik], false), null);
// Statements, too short or too long lines fail; fewer than two left -> null.
assert.equal(parseExamples("Deep learning maps water well.\nWhy?\nHow do these papers approach surface water mapping with deep learning?", [luo, isik], false), null);
assert.deepEqual(parseExamples("How does it approach surface water mapping?\nWhich data does this paper use for Landsat scenes?", [isik], true), [
	"How does it approach surface water mapping?",
	"Which data does this paper use for Landsat scenes?",
]);
// "et al." is not counted; the paper count of the prompt may appear.
assert.deepEqual(parseExamples("How does Legleiter et al. 2009 measure river depth compared to Isikdogan et al. 2017 surface water mapping?\nHow do these 2 papers approach surface water mapping?", [luo, isik, { name: "Legleiter et al. 2009", title: "Spectrally based remote sensing of river bathymetry", keywords: ["river depth"] }].slice(1), false), [
	"How does Legleiter et al. 2009 measure river depth compared to Isikdogan et al. 2017 surface water mapping?",
	"How do these 2 papers approach surface water mapping?",
]);
// A question about the keyword list itself fails.
assert.equal(parseExamples("Which keywords link surface water mapping in these papers?\nHow is surface water mapped?", [luo, isik], false), null);
// Names in "Last, First" form keep the surname.
assert.equal(examplePaperName(["Hodson, A.J.", "Porter, P.R.", "Lowe, A."], "2003", "x"), "Hodson et al. 2003");
assert.equal(examplePaperName(["Yun Du", "Feng Ling"], "2016", "x"), "Du and Ling 2016");
assert.equal(examplePaperName([], null, "2016_Du_mapping"), "2016_Du_mapping");

console.log("examples tests ok");
