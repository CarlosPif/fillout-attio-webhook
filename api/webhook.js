// api/webhook.js
// Endpoint para Vercel Serverless Functions

export default async function handler(req, res) {
  // Solo aceptar POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const filloutData = req.body;
    
    // Configuración - IDs conocidos
    const FILLOUT_DOMAIN_FIELD_ID = process.env.FILLOUT_DOMAIN_FIELD_ID;
    const ATTIO_DOMAIN_ATTRIBUTE = process.env.ATTIO_DOMAIN_ATTRIBUTE || 'domains';
    const ATTIO_API_KEY = process.env.ATTIO_API_KEY;
    const ATTIO_LIST_ID = process.env.ATTIO_LIST_ID;
    
    // MAPEO DE CAMPOS: Edita aquí para mapear tus campos de Fillout a Attio
    const FILLOUT_FIELD_MAPPINGS = {
      // Formato: 'id_campo_fillout': 'nombre_atributo_attio'
      // Ejemplos (reemplaza con tus IDs reales):
      // 'jks8d9f': 'contact_email',
      // 'mne8w2q': 'phone_number',
      // 'pol9x3r': 'status',
      // 'abc1234': 'notes',
    };

    // Validar variables de entorno
    if (!ATTIO_API_KEY || !ATTIO_LIST_ID || !FILLOUT_DOMAIN_FIELD_ID) {
      throw new Error('Missing required environment variables: ATTIO_API_KEY, ATTIO_LIST_ID, or FILLOUT_DOMAIN_FIELD_ID');
    }

    // Extraer el dominio del formulario de Fillout
    const responses = filloutData.questions || [];
    const domainQuestion = responses.find(q => q.id === FILLOUT_DOMAIN_FIELD_ID);
    const domain = domainQuestion?.value;
    
    if (!domain) {
      return res.status(400).json({ 
        error: 'Domain not provided',
        message: `No se encontró el campo de dominio con ID: ${FILLOUT_DOMAIN_FIELD_ID}`,
        receivedFields: responses.map(q => ({ id: q.id, name: q.name }))
      });
    }

    console.log(`📥 Webhook recibido para dominio: ${domain}`);

    const attioHeaders = {
      'Authorization': `Bearer ${ATTIO_API_KEY}`,
      'Content-Type': 'application/json'
    };

    // PASO 1: Buscar la Company por dominio en el objeto Companies
    console.log(`🔍 Buscando company con dominio: ${domain}`);
    
    const searchCompanyResponse = await fetch(
      'https://api.attio.com/v2/objects/companies/records/query',
      {
        method: 'POST',
        headers: attioHeaders,
        body: JSON.stringify({
          filter: {
            [ATTIO_DOMAIN_ATTRIBUTE]: {
              $contains: domain
            }
          },
          limit: 1
        })
      }
    );

    if (!searchCompanyResponse.ok) {
      const error = await searchCompanyResponse.json();
      console.error('❌ Error buscando company:', error);
      throw new Error(`Error buscando company: ${JSON.stringify(error)}`);
    }

    const companyData = await searchCompanyResponse.json();
    
    if (!companyData.data || companyData.data.length === 0) {
      console.log('❌ Company no encontrada');
      return res.status(404).json({ 
        error: 'Company not found',
        message: `No se encontró ninguna empresa con el dominio: ${domain}`
      });
    }

    const companyId = companyData.data[0].id.record_id;
    console.log(`✅ Company encontrada - ID: ${companyId}`);

    // PASO 2: Buscar el entry en la lista que esté asociado a esta Company
    console.log(`🔍 Buscando entry en lista ${ATTIO_LIST_ID} para company ${companyId}`);
    
    const searchListResponse = await fetch(
      `https://api.attio.com/v2/lists/${ATTIO_LIST_ID}/entries/query`,
      {
        method: 'POST',
        headers: attioHeaders,
        body: JSON.stringify({
          filter: {
            'parent_record': {
              target_object: 'companies',
              target_record_id: companyId
            }
          },
          limit: 1
        })
      }
    );

    if (!searchListResponse.ok) {
      const error = await searchListResponse.json();
      console.error('❌ Error buscando entry en lista:', error);
      throw new Error(`Error buscando entry en lista: ${JSON.stringify(error)}`);
    }

    const listData = await searchListResponse.json();
    
    if (!listData.data || listData.data.length === 0) {
      console.log('❌ Entry no encontrado en la lista');
      return res.status(404).json({ 
        error: 'List entry not found',
        message: `No se encontró un entry en la lista para la empresa con dominio: ${domain}`,
        companyId: companyId,
        hint: 'Verifica que existe un entry en tu lista vinculado a esta company'
      });
    }

    const entryId = listData.data[0].id.entry_id;
    console.log(`✅ Entry encontrado - ID: ${entryId}`);

    // PASO 3: Mapear los campos de Fillout a atributos de Attio
    const updateData = {};
    
    // Usar el mapeo definido arriba
    for (const [filloutFieldId, attioAttribute] of Object.entries(FILLOUT_FIELD_MAPPINGS)) {
      const question = responses.find(q => q.id === filloutFieldId);
      if (question && question.value !== null && question.value !== undefined) {
        updateData[attioAttribute] = question.value;
        console.log(`📝 Mapeando: ${filloutFieldId} (${question.name}) → ${attioAttribute} = ${question.value}`);
      }
    }

    // Si no hay campos mapeados, usar mapeo automático (excluyendo el campo de dominio)
    if (Object.keys(updateData).length === 0) {
      console.log('⚠️ No hay campos específicos mapeados, usando mapeo automático');
      for (const question of responses) {
        if (question.id !== FILLOUT_DOMAIN_FIELD_ID && question.value) {
          const attributeName = question.name || question.id;
          updateData[attributeName] = question.value;
          console.log(`📝 Auto-mapeado: ${attributeName} = ${question.value}`);
        }
      }
    }

    if (Object.keys(updateData).length === 0) {
      console.log('❌ No hay campos para actualizar');
      return res.status(400).json({
        error: 'No fields to update',
        message: 'No se encontraron campos para actualizar en el formulario',
        receivedFields: responses.map(q => ({ id: q.id, name: q.name, value: q.value }))
      });
    }

    console.log(`🔄 Actualizando entry con ${Object.keys(updateData).length} campos`);

    // PASO 4: Actualizar el entry en la lista
    const updateResponse = await fetch(
      `https://api.attio.com/v2/lists/${ATTIO_LIST_ID}/entries/${entryId}`,
      {
        method: 'PATCH',
        headers: attioHeaders,
        body: JSON.stringify({
          data: {
            values: updateData
          }
        })
      }
    );

    if (!updateResponse.ok) {
      const error = await updateResponse.json();
      console.error('❌ Error actualizando entry:', error);
      throw new Error(`Error actualizando entry: ${JSON.stringify(error)}`);
    }

    const updatedEntry = await updateResponse.json();
    console.log(`✅ Entry actualizado exitosamente`);

    // PASO 5: Responder exitosamente
    return res.status(200).json({
      success: true,
      message: `Entry actualizado correctamente para el dominio: ${domain}`,
      details: {
        companyId: companyId,
        entryId: entryId,
        updatedFields: Object.keys(updateData),
        values: updateData
      }
    });

  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      timestamp: new Date().toISOString()
    });
  }
}