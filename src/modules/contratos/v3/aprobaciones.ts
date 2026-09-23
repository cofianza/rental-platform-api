/**
 * Contratos V3 — borradores aprobados (Entrega 2, diseño §6.c).
 *
 * Todo texto que no está en el Word va en la plantilla como borrador
 * `[[cond: texto Word | #id: borrador]]` y bloquea el modo final hasta que
 * alguien con autoridad (Mario / Gerencia) lo apruebe. Aprobarlo = agregar aquí
 * su entrada, en un commit propio, con el sha256 que imprime borradores.txt
 * (Plantilla.borradores[].sha256):
 *
 *   'c-01': { sha256: '<64 hex>', aprobadoPor: 'Mario …', fecha: '2026-09-30' },
 *
 * La aprobación queda atada al TEXTO: si el borrador se edita, su sha256 cambia
 * y vuelve a quedar pendiente (el motor compara `sha256`, nada más).
 */

export interface Aprobacion {
  /** sha256 del texto del borrador tal como está en la plantilla. */
  sha256: string;
  /** Quién lo aprobó, como consta en el correo o acta. */
  aprobadoPor: string;
  /** AAAA-MM-DD de la aprobación. */
  fecha: string;
}

/** Adenda 1 del módulo de contratos (Gerencia, 2026-09-23): la respuesta que aprueba el texto. */
const adenda1 = (resp: 1 | 2 | 4): Omit<Aprobacion, 'sha256'> => ({
  aprobadoPor: `Mario Vélez (Gerencia General) — Adenda 1 contratos, resp. ${resp}`,
  fecha: '2026-09-23',
});

/** id del borrador → aprobación. */
export const APROBACIONES: Readonly<Record<string, Aprobacion>> = {
  // resp. 2 — Tradicional: EL ARRENDADOR asume prima y tarifa (b-01, CUARTA) y el resumen
  // cambia el cashback de EL ARRENDATARIO por la fianza asumida (b-02). b-03…b-05 sacan del
  // resumen lo que le atribuía tarifa o cashback (V3 §3.4.5): se le informan a Gerencia.
  'b-01': { sha256: '2486f537350cdc14b3d2dfc974441df3e2daa71358dfa5942e437011a0ca9f81', ...adenda1(2) },
  'b-02': { sha256: 'fcba65662f2e58be93637d0c4638cc63d22e25d2a804bea8e24ae184bac3570c', ...adenda1(2) },
  'b-03': { sha256: '7a5356659c5b128bf2a1cfa958aca12b66573ecc89e0089dd5a74018541868aa', ...adenda1(2) },
  'b-04': { sha256: '21e98de4bff8ba65839db50a88e4d319b496f84a5c44e55f68c0d5f7ccac2876', ...adenda1(2) },
  'b-05': { sha256: 'faf4cec4bc508b56f1caec91198c3272a833310be34f481f21f471b40bf23b43', ...adenda1(2) },
  // resp. 1 — singular sin coarrendatario, con las dos supresiones autorizadas: c-13 quita
  // «de manera solidaria» y a-c-02 la activación condicionada a la firma del coarrendatario.
  'c-01': { sha256: '7e60cb84684a44d89f4ed34a5e8ed3e9e5b5eff909d34bb52d9a5b66b84b57c9', ...adenda1(1) },
  'c-02': { sha256: '9aa4b55f65fcb165b6ddb58d94ee7254c4b6507e153af816af57937f15a0c527', ...adenda1(1) },
  'c-03': { sha256: '482aefcdedb850f9ed9da2a2718377dcb787ed81fd150683e043e0e53557c59b', ...adenda1(1) },
  'c-04': { sha256: '307931a0f070a2d6789406e5f75dbbbc4383a180c5e66b5b3e72dc44e4d7257a', ...adenda1(1) },
  'c-05': { sha256: '29e19f5ced1e2c296d24bee641762f0732304b6c36be4bb8e7698feced9ef564', ...adenda1(1) },
  'c-06': { sha256: '2c286dbeeb791d776494d36ecad0e833a5ea1307576e527ae4b2c9687203d42c', ...adenda1(1) },
  'c-07': { sha256: 'bc44a3eb7d5f4d6b5e06c9ffea333fbdadeaf0e31f0c1def015abe2192921346', ...adenda1(1) },
  'c-08': { sha256: 'b1bc4992dbec6673fdfde25aa9c8a0053a1be076d2b97f778e9d10aab1ef182a', ...adenda1(1) },
  'c-09': { sha256: 'ef41d02a3d2cce65bca7197d6500bb395faa47811c9858311a6fbe2876ee3d10', ...adenda1(1) },
  'c-10': { sha256: 'dd027a3d79a6e9cc2888d28f962eb2f0eacfc93b0a112a7343ea87771c67d941', ...adenda1(1) },
  'c-11': { sha256: '8477735fd30508eb56e28eb6c56e7df5bb3165b76045508b4b3954720cc777c9', ...adenda1(1) },
  'c-12': { sha256: '8f7152cb52c5c82f2c79b589d8085a0abaeebf74297707db1c700ba8ae24d0c6', ...adenda1(1) },
  'c-13': { sha256: 'be53e7d3e212f905703db527ad6391d0ea10e04e11afb1cdf4b98ac32056b264', ...adenda1(1) },
  'c-14': { sha256: 'e948c50a61a61b352a30f0271d2af9caa5c2b8c8f862aac4dc67600ff9e3e398', ...adenda1(1) },
  'c-15': { sha256: 'b3e2313ece73b619a0b8c114e1753c1c3f2fd870fbaf40087660f7fd3f8f5636', ...adenda1(1) },
  'c-16': { sha256: '8e5d7969af81a99e5ffe6a1237a84f7fb046f01f9a03318ac3094993f96446d7', ...adenda1(1) },
  'c-17': { sha256: 'c47bffb7200e9ecf82479cc32f2a8409f6917b766337e213f54144e5739693a4', ...adenda1(1) },
  'c-18': { sha256: '7e60cb84684a44d89f4ed34a5e8ed3e9e5b5eff909d34bb52d9a5b66b84b57c9', ...adenda1(1) },
  'c-19': { sha256: 'df5b4d05cc353d7f3c4c893b3032228098d8fc43e8a363ded3590da9fcf5c7e9', ...adenda1(1) },
  'c-20': { sha256: '3c80dbb0dc4aff56ef6beeaa8f9820b504df64e361a15401f7172ec6d0666ab9', ...adenda1(1) },
  'c-21': { sha256: 'd825048f888aa3f330502a5d64b4c9efd3ba412e67e85d0256e6e3c9ceeffa1d', ...adenda1(1) },
  'c-22': { sha256: 'ee33baa92e44d08fabfad043348053cf5fa31a567c1aaaa4d4b192034a48f912', ...adenda1(1) },
  'c-23': { sha256: '73dc23fabed4677d7e11e914d3bd1606cf11df0deda9cea933f05e2ff5a2c5e4', ...adenda1(1) },
  'c-24': { sha256: '2e614092ff9c6362f4a3c65193dc0065d160d4d585555cba5b7e50e6176c5569', ...adenda1(1) },
  'a-c-01': { sha256: 'cad3074db25f3ba64f2b8dbc1c25368e42726fc4cd9e41d9393c84e08d548611', ...adenda1(1) },
  'a-c-02': { sha256: '9c0cf085bcaa056b7bf70f3967f8e56f8c6b59a866606e5d9fab8b9552b1cdfb', ...adenda1(1) },
  'a-c-03': { sha256: '09109138903cda25270ae77a6e6ddd8a823fd62b875e6770b469560132d00dc9', ...adenda1(1) },
  'a-c-04': { sha256: '3fb7e5fa959fc9b219c24a035d0ab424154dd4df124197ccdb0255e304260785', ...adenda1(1) },
  'a-c-05': { sha256: 'fb1b2e6baed34be6720438e86ae5f2bb8ec1e9e6080e23e0b5cf74e6a5d8234f', ...adenda1(1) },
  'a-c-06': { sha256: 'cad3074db25f3ba64f2b8dbc1c25368e42726fc4cd9e41d9393c84e08d548611', ...adenda1(1) },
  'a-c-07': { sha256: 'b3e2313ece73b619a0b8c114e1753c1c3f2fd870fbaf40087660f7fd3f8f5636', ...adenda1(1) },
  'a-c-08': { sha256: '73dc23fabed4677d7e11e914d3bd1606cf11df0deda9cea933f05e2ff5a2c5e4', ...adenda1(1) },
  'a-c-09': { sha256: '2e614092ff9c6362f4a3c65193dc0065d160d4d585555cba5b7e50e6176c5569', ...adenda1(1) },
  'a-c-10': { sha256: 'fed0c1e623b1b938d66ad67b4c3add8c96ace2479e1a811a21c16e3f0f0e4d7f', ...adenda1(1) },
  'a-c-11': { sha256: '2c286dbeeb791d776494d36ecad0e833a5ea1307576e527ae4b2c9687203d42c', ...adenda1(1) },
  // resp. 4 — el tipo de documento real, no C.C. fijo.
  'j-coa-doc': { sha256: 'b7c156e7f8e1bd0840e4cc56acfd9b44f24d36864385e199230177c1f953291a', ...adenda1(4) },
  'j-firma-arrendatario': { sha256: 'cba3652cbf4a406406be7d8f7b0914e45ee5ab59f35e85da04d988c87d27e90e', ...adenda1(4) },
  'j-firma-coa': { sha256: '653df81c0d343fc2ebdaee3cf9d6b576c8defe3c11d15425372629746ac71557', ...adenda1(4) },
  'a-j-cuadro-arrendatario': { sha256: 'cba3652cbf4a406406be7d8f7b0914e45ee5ab59f35e85da04d988c87d27e90e', ...adenda1(4) },
  'a-j-cuadro-coa': { sha256: '63449de486a2290a63280439d1854db1d5d5d9be9106ec4076878d779f9a5197', ...adenda1(4) },
  'a-j-firma-arrendatario': { sha256: 'cba3652cbf4a406406be7d8f7b0914e45ee5ab59f35e85da04d988c87d27e90e', ...adenda1(4) },
  'a-j-firma-coa': { sha256: '653df81c0d343fc2ebdaee3cf9d6b576c8defe3c11d15425372629746ac71557', ...adenda1(4) },
};
