import express from "express";

const app = express();
const port = process.env.PORT || 3000;

// Para leer JSON en req.body
app.use(express.json());

// Configuración fija (ajústalo a tu caso)
const FILLOUT_DOMAIN_FIELD_ID = "6aYW";
const ATTIO_DOMAIN_ATTRIBUTE = "domains";
const ATTIO_API_KEY = process.env.ATTIO_API_KEY;
const ATTIO_LIST_ID = "e2f1f046-d64f-4b4a-8e90-25b7c10140ba";

const FILLOUT_FIELD_MAPPINGS = {
  wrV6: "hdd_evaluation_1",
  "6rxp": "hdd_evaluation_2",
};

// Healthcheck sencillo para probar que el servicio está vivo
app.get("/", (req, res) => {
  res.send("✅ Attio webhook running on Railway");
});

app.post("/webhook", async (req, res) => {
  console.log("🔔 Webhook recibido - método:", req.method);
  console.log("📦 Body bruto recibido desde Fillout:", JSON.stringify(req.body, null, 2));

  try {
    const filloutData = req.body;

    if (!ATTIO_API_KEY || !ATTIO_LIST_ID || !FILLOUT_DOMAIN_FIELD_ID) {
      throw new Error(
        "Missing required environment variables: ATTIO_API_KEY, ATTIO_LIST_ID, or FILLOUT_DOMAIN_FIELD_ID"
      );
    }

    // 👇 NUEVO: detectar el array de preguntas según el formato real
    let responses = [];

    if (Array.isArray(filloutData.questions)) {
      // Formato plano: { questions: [...] }
      responses = filloutData.questions;
    } else if (
      Array.isArray(filloutData.responses) &&
      filloutData.responses.length > 0 &&
      Array.isArray(filloutData.responses[0].questions)
    ) {
      // Formato tipo API: { responses: [ { questions: [...] } ] }
      responses = filloutData.responses[0].questions;
    } else if (
      filloutData.response &&
      Array.isArray(filloutData.response.questions)
    ) {
      // Por si viene como { response: { questions: [...] } }
      responses = filloutData.response.questions;
    }

    if (!Array.isArray(responses) || responses.length === 0) {
      console.warn("⚠️ No se encontraron preguntas en el payload de Fillout");
      return res.status(400).json({
        error: "No questions in payload",
        message:
          "No se encontraron preguntas en el body recibido desde Fillout. Revisa el formato del payload y el ID del campo.",
        rawBody: filloutData,
      });
    }

    // Buscar el dominio
    const domainQuestion = responses.find(
      (q) => q.id === FILLOUT_DOMAIN_FIELD_ID
    );
    const domain = domainQuestion?.value;

    if (!domain) {
      return res.status(400).json({
        error: "Domain not provided",
        message: `No se encontró el campo de dominio con ID: ${FILLOUT_DOMAIN_FIELD_ID}`,
        receivedFields: responses.map((q) => ({
          id: q.id,
          name: q.name,
          value: q.value,
        })),
      });
    }

    console.log(`📥 Webhook recibido para dominio: ${domain}`);

    const attioHeaders = {
      Authorization: `Bearer ${ATTIO_API_KEY}`,
      "Content-Type": "application/json",
    };

    // PASO 1: Buscar Company por dominio
    console.log(`🔍 Buscando company con dominio: ${domain}`);

    const searchCompanyResponse = await fetch(
      "https://api.attio.com/v2/objects/companies/records/query",
      {
        method: "POST",
        headers: attioHeaders,
        body: JSON.stringify({
          filter: {
            [ATTIO_DOMAIN_ATTRIBUTE]: {
              $contains: domain,
            },
          },
          limit: 1,
        }),
      }
    );

    if (!searchCompanyResponse.ok) {
      const error = await searchCompanyResponse.json();
      console.error("❌ Error buscando company:", error);
      throw new Error(`Error buscando company: ${JSON.stringify(error)}`);
    }

    const companyData = await searchCompanyResponse.json();

    if (!companyData.data || companyData.data.length === 0) {
      console.log("❌ Company no encontrada");
      return res.status(404).json({
        error: "Company not found",
        message: `No se encontró ninguna empresa con el dominio: ${domain}`,
      });
    }

    const companyId = companyData.data[0].id.record_id;
    console.log(`✅ Company encontrada - ID: ${companyId}`);

    // PASO 2: Buscar entry en la lista
    console.log(
      `🔍 Buscando entry en lista ${ATTIO_LIST_ID} para company ${companyId}`
    );

    const searchListResponse = await fetch(
      `https://api.attio.com/v2/lists/${ATTIO_LIST_ID}/entries/query`,
      {
        method: "POST",
        headers: attioHeaders,
        body: JSON.stringify({
          filter: {
            parent_record: {
              target_object: "companies",
              target_record_id: companyId,
            },
          },
          limit: 1,
        }),
      }
    );

    if (!searchListResponse.ok) {
      const error = await searchListResponse.json();
      console.error("❌ Error buscando entry en lista:", error);
      throw new Error(
        `Error buscando entry en lista: ${JSON.stringify(error)}`
      );
    }

    const listData = await searchListResponse.json();

    if (!listData.data || listData.data.length === 0) {
      console.log("❌ Entry no encontrado en la lista");
      return res.status(404).json({
        error: "List entry not found",
        message: `No se encontró un entry en la lista para la empresa con dominio: ${domain}`,
        companyId: companyId,
      });
    }

    const entryId = listData.data[0].id.entry_id;
    console.log(`✅ Entry encontrado - ID: ${entryId}`);

    // PASO 3: Mapear campos Fillout → Attio
    const updateData = {};

    for (const [filloutFieldId, attioAttribute] of Object.entries(
      FILLOUT_FIELD_MAPPINGS
    )) {
      const question = responses.find((q) => q.id === filloutFieldId);
      if (question && question.value !== null && question.value !== undefined) {
        updateData[attioAttribute] = question.value;
        console.log(
          `📝 Mapeando: ${filloutFieldId} (${question.name}) → ${attioAttribute} = ${question.value}`
        );
      }
    }

    if (Object.keys(updateData).length === 0) {
      console.log(
        "⚠️ No hay campos específicos mapeados, usando mapeo automático"
      );
      for (const question of responses) {
        if (question.id !== FILLOUT_DOMAIN_FIELD_ID && question.value) {
          const attributeName = question.name || question.id;
          updateData[attributeName] = question.value;
          console.log(`📝 Auto-mapeado: ${attributeName} = ${question.value}`);
        }
      }
    }

    if (Object.keys(updateData).length === 0) {
      console.log("❌ No hay campos para actualizar");
      return res.status(400).json({
        error: "No fields to update",
        message: "No se encontraron campos para actualizar en el formulario",
        receivedFields: responses.map((q) => ({
          id: q.id,
          name: q.name,
          value: q.value,
        })),
      });
    }

    console.log(
      `🔄 Actualizando entry con ${Object.keys(updateData).length} campos`
    );

    // PASO 4: PATCH a Attio
    const updateResponse = await fetch(
      `https://api.attio.com/v2/lists/${ATTIO_LIST_ID}/entries/${entryId}`,
      {
        method: "PATCH",
        headers: attioHeaders,
        body: JSON.stringify({
          data: {
            values: updateData,
          },
        }),
      }
    );

    if (!updateResponse.ok) {
      const error = await updateResponse.json();
      console.error("❌ Error actualizando entry:", error);
      throw new Error(`Error actualizando entry: ${JSON.stringify(error)}`);
    }

    const updatedEntry = await updateResponse.json();
    console.log("✅ Entry actualizado exitosamente");

    return res.status(200).json({
      success: true,
      message: `Entry actualizado correctamente para el dominio: ${domain}`,
      details: {
        companyId,
        entryId,
        updatedFields: Object.keys(updateData),
        values: updateData,
        attioResponse: updatedEntry,
      },
    });
  } catch (error) {
    console.error("❌ Error processing webhook:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server listening on port ${port}`);
});
