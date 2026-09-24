/**
 * Solo dígitos y con indicativo: «300 111 2233», «+57 300 1112233» y
 * «573001112233» son el mismo número. Diez dígitos = celular de Colombia sin 57.
 */
export function telefonoNormalizado(telefono: string): string {
  const digitos = telefono.replace(/\D/g, '');
  return digitos.length === 10 ? `57${digitos}` : digitos;
}
