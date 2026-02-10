# rental-platform-api

API REST para **Habitar Propiedades 2.0**, una plataforma de garantias de arrendamiento en Colombia. Este servicio maneja toda la logica de negocio: autenticacion, gestion de usuarios y roles, expedientes, inmuebles, documentos, evaluacion de arrendatarios, contratos, firma electronica, pagos, facturacion y reportes.

## Stack

- **Node.js** + **Express 5**
- **TypeScript**
- **Helmet** (seguridad HTTP)
- **CORS** + **Morgan** (logging)

## Inicio rapido

```bash
npm install
cp .env.example .env
npm run dev
```

El servidor corre en [http://localhost:4000](http://localhost:4000).

## Scripts

| Comando | Descripcion |
|---------|-------------|
| `npm run dev` | Servidor de desarrollo con nodemon |
| `npm run build` | Compila TypeScript a JavaScript |
| `npm start` | Servidor de produccion |

## Estructura

```
src/
├── config/        # Variables de entorno
├── controllers/   # Controladores de rutas
├── middleware/     # Error handler, auth, validaciones
├── models/        # Modelos de datos
├── routes/        # Definicion de rutas
├── services/      # Logica de negocio
├── utils/         # Utilidades
├── app.ts         # Configuracion de Express
└── server.ts      # Entry point
```
