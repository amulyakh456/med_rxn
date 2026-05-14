'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');

const COMMON_DRUGS = [
  'aspirin','paracetamol','ibuprofen','warfarin','metformin','atorvastatin',
  'amlodipine','losartan','omeprazole','pantoprazole','amoxicillin','azithromycin',
  'ciprofloxacin','metronidazole','prednisolone','dexamethasone','insulin',
  'digoxin','furosemide','spironolactone','atenolol','metoprolol','ramipril',
  'clopidogrel','rosuvastatin','gabapentin','alprazolam','diazepam',
  'sertraline','fluoxetine','amitriptyline','tramadol','codeine','morphine',
  'phenytoin','valproate','carbamazepine','rifampicin','isoniazid','ethambutol',
  'hydroxychloroquine','colchicine','allopurinol','methotrexate','cyclosporine',
  'tacrolimus','lithium','haloperidol','clozapine','olanzapine',
  'lorazepam','clonazepam','midazolam','zolpidem',
];

const SYSTEM_PROMPT = `You are a clinical pharmacology expert specializing in Indian medicines.
When given an Indian brand medicine name and a list of other drugs in the prescription, return a JSON object.

IMPORTANT GUIDANCE:
- Indian pharma has thousands of niche regional brands you may not recognize directly.
- If the brand name suggests an ingredient pattern (e.g. "Kojiclar" → Kojic acid, "Cipla-X" → likely a Cipla product, "Pan D" → Pantoprazole+Domperidone), use that reasoning to identify likely ingredients.
- Set "is_real_medicine": true if the name plausibly matches an Indian pharmaceutical product, even if you cannot confirm with 100% certainty.
- Only set "is_real_medicine": false for clearly nonsensical strings or known non-medicines.
- Use the "confidence" field (0.0-1.0) to express how sure you are. Low confidence is fine — partial info is better than no info.
- Be concise. Only include clinically significant interactions (not theoretical ones).
- Return ONLY valid JSON with no markdown or explanation.`;

class GeminiEnricher {
  constructor(apiKey) {
    if (!apiKey) throw new Error('GEMINI_API_KEY is required');
    this.client = new GoogleGenerativeAI(apiKey);
    this.model = this.client.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
    console.log('[gemini] using gemini-2.5-flash-lite (3-6x cheaper)');
  }

  async enrichMedicine(brandName, prescriptionDrugs = []) {
    const prompt = `
${SYSTEM_PROMPT}

Unknown Indian medicine: "${brandName}"
Other drugs in current prescription: ${prescriptionDrugs.length ? prescriptionDrugs.join(', ') : 'none'}
Common drugs to check against: ${COMMON_DRUGS.join(', ')}

Return JSON:
{
  "is_real_medicine": boolean,
  "brand_name": "corrected/confirmed brand name",
  "generic_name": "active ingredient(s), e.g. Domperidone or Paracetamol + Caffeine",
  "active_ingredients": ["ingredient 1", "ingredient 2"],
  "confidence": 0.0-1.0,
  "prescription_interactions": [
    {
      "drug": "drug name from prescription",
      "severity": "Major|Moderate|Minor|Safe",
      "side_effects": "what patient experiences",
      "mechanism": "why interaction occurs",
      "clinical_action": "what doctor should do"
    }
  ],
  "common_interactions": [
    {
      "drug": "drug name from common list",
      "severity": "Major|Moderate|Minor|Safe",
      "side_effects": "what patient experiences",
      "mechanism": "why interaction occurs",
      "clinical_action": "what doctor should do"
    }
  ]
}

Only include interactions with severity Major, Moderate, or Minor. Skip Safe ones.
`;

    const result = await this.model.generateContent(prompt);
    const text = result.response.text().trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');

    const data = JSON.parse(text);
    return data;
  }

  async enrichDrugPair(drugA, drugB) {
    const prompt = `You are a clinical pharmacology expert. For this drug pair, identify the main clinical risk/effect.

Drug A: ${drugA}
Drug B: ${drugB}

Determine the severity and provide a one-sentence main clinical effect. Return ONLY valid JSON:
{
  "drug_a": "${drugA}",
  "drug_b": "${drugB}",
  "severity": "Major|Moderate|Minor|Safe",
  "clinical_effect": "one sentence describing main risk/effect"
}

Examples:
{"drug_a": "warfarin", "drug_b": "aspirin", "severity": "Major", "clinical_effect": "Increased risk of gastrointestinal and other bleeding due to additive antiplatelet/anticoagulant effects"}
{"drug_a": "metformin", "drug_b": "alcohol", "severity": "Moderate", "clinical_effect": "Increased risk of lactic acidosis and hypoglycemia"}
{"drug_a": "ibuprofen", "drug_b": "lisinopril", "severity": "Moderate", "clinical_effect": "Reduced antihypertensive effect and increased risk of renal impairment"}`;

    const result = await this.model.generateContent(prompt);
    const text = result.response.text().trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');

    return JSON.parse(text);
  }
}

module.exports = { GeminiEnricher, COMMON_DRUGS };
