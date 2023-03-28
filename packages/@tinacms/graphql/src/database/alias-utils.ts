import { Template, TinaFieldEnriched } from '@tinacms/schema-tools/src'

export const replaceNameOverrides = (template: Template, obj: any) => {
  if ((template as any).list) {
    return (obj as any[]).map((item) => {
      return _replaceNameOverrides(
        getTemplateForData(template, item).fields,
        item
      )
    })
  } else {
    return _replaceNameOverrides(getTemplateForData(template, obj).fields, obj)
  }
}

const _replaceNameOverrides = (fields: TinaFieldEnriched[], obj: any) => {
  const output: object = {}

  Object.keys(obj).forEach((key) => {
    const field = fields.find(
      (fieldWithMatchingAlias) =>
        (fieldWithMatchingAlias?.nameOverride ||
          fieldWithMatchingAlias?.name) === key
    )

    output[field?.name || key] =
      field?.type == 'object'
        ? replaceNameOverrides(field as any, obj[key])
        : obj[key]
  })

  return output
}

const getTemplateKey = (field) => {
  return field?.templateKey || '_template'
}

const getTemplateForData = (field: any, data: any) => {
  if (field.templates?.length) {
    const templateKey = getTemplateKey(field)

    if (data[templateKey]) {
      const result = field.templates.find(
        (template) =>
          template.nameOverride === data[templateKey] ||
          template.name === data[templateKey]
      )
      if (result) {
        return result
      }
    }
  } else {
    return field
  }

  throw new Error('No template found for field ' + field.name)
}

export const applyNameOverrides = (template: Template, obj: any): object => {
  if ((template as any).list) {
    return (obj as any[]).map((item) => {
      return _applyNameOverrides(
        getTemplateForData(template, item).fields,
        item
      )
    })
  } else {
    return _applyNameOverrides(getTemplateForData(template, obj).fields, obj)
  }
}

const _applyNameOverrides = (fields: TinaFieldEnriched[], obj: any): object => {
  const output: object = {}
  Object.keys(obj).forEach((key) => {
    const field = fields.find((field) => field.name === key)

    const outputKey = field?.nameOverride || key
    output[outputKey] =
      field?.type === 'object'
        ? applyNameOverrides(field as any, obj[key])
        : obj[key]
  })
  return output
}
