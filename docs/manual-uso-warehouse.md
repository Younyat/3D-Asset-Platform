# Manual De Uso: Warehouse, Piezas Y Workspace

Este manual describe el flujo operativo para importar un modelo completo, desmantelarlo en piezas, guardarlas de forma permanente en el warehouse del proyecto, refrescar la plataforma y volver a importar piezas guardadas al workspace.

## Objetivo Del Flujo

El objetivo es comprobar que las piezas no se quedan solo como datos temporales de la pantalla. Cada pieza guardada permanentemente debe convertirse en un objeto 3D fisico dentro del proyecto, en formato `.glb`, y debe poder volver a importarse al escenario despues de refrescar la pagina.

Desde la fase mecanica funcional, una pieza guardada tambien puede contener `FunctionalComponent`: interfaces mecanicas, propiedades funcionales, origen, transformacion y subgrafo `KinematicGraph`. Un conjunto guardado puede contener `FunctionalAssembly` con componentes, conexiones, joints, limites y validacion.

## Flujo Principal Verificado

1. Abrir la plataforma en el navegador.
2. En el panel izquierdo, pulsar `3D Model`.
3. Seleccionar un modelo completo. En la prueba se uso `Rmk3.obj`.
4. Esperar a que el modelo aparezca visible en el escenario.
5. Seleccionar el modelo importado.
6. Pulsar `Dismantle selected model into warehouse`.
7. Abrir `Warehouse dashboard`.
8. Pulsar `Save All`.
9. Comprobar que el contador superior del warehouse muestra objetos guardados y peso ocupado.
10. Refrescar la pagina del navegador.
11. Volver al workspace.
12. En el panel izquierdo, revisar la seccion `Saved Objects`.
13. Si los objetos no aparecen automaticamente, pulsar `Load Saved`.
14. Pulsar `Import saved warehouse object to workspace`.
15. Verificar que el objeto aparece visualmente en el escenario.
16. Seleccionar el objeto importado en el workspace.
17. Modificar color, escala, posicion, rotacion o duplicar la pieza si hace falta.
18. Cuando el boton superior `Save workspace changes permanently` se active, pulsarlo para guardar fisicamente los cambios.
19. Pulsar `Save selected object as project warehouse GLB` si se quiere guardar solo el objeto seleccionado.
20. Volver a `Warehouse dashboard`.
21. Verificar que sube el numero de objetos guardados o el peso ocupado.

## Flujo Alternativo Desde El Warehouse

1. Abrir `Warehouse dashboard`.
2. Hacer clic derecho sobre una pieza guardada.
3. Pulsar `Send to scene`.
4. Volver al workspace.
5. Verificar que la pieza aparece visualmente en el escenario.
6. Seleccionar la pieza en escena.
7. Usar `Save Copy` para crear una copia nueva en el warehouse.
8. Usar `Save workspace changes permanently` para guardar todos los cambios pendientes del workspace.
9. Usar `Save selected object as project warehouse GLB` para guardar solo el objeto seleccionado como GLB fisico permanente del proyecto.

## Botones Importantes

- `3D Model`: importa un modelo 3D completo al workspace.
- `Dismantle selected model into warehouse`: separa el modelo seleccionado en piezas detectadas.
- `Warehouse dashboard`: abre el dashboard separado del almacen de piezas.
- `Save All`: guarda permanentemente todas las piezas nuevas del warehouse.
- `Load Saved`: carga desde disco los objetos permanentes del warehouse del proyecto.
- `Import saved warehouse object to workspace`: importa al escenario el primer objeto guardado permanentemente.
- `Save workspace changes permanently`: se activa cuando hay objetos nuevos, copiados o modificados en el workspace; guarda esos cambios como `.glb` fisicos.
- `Save selected object as project warehouse GLB`: guarda el objeto seleccionado del workspace como nuevo `.glb` permanente.
- `Send to scene`: envia una pieza del warehouse al workspace desde el menu contextual.
- `Save Copy`: crea una copia de la pieza seleccionada dentro del warehouse.
- `Store Assembly`: guarda el conjunto actual de piezas del escenario como una entidad compuesta.
- `Delete selected object permanently`: borra el objeto seleccionado del workspace y, si tiene fichero asociado, tambien lo elimina del warehouse fisico.
- `Delete`: en el dashboard del warehouse borra la pieza seleccionada del manifest y del fichero local asociado.

## Informacion Funcional Guardada

Cada pieza desmontada o guardada desde workspace conserva:

- `FunctionalComponent`;
- interfaces mecanicas compatibles;
- propiedades mecanicas inferidas;
- transformacion local y origen;
- subgrafo cinematico basado en `KinematicGraph` cuando existe informacion original.

Cada assembly guardado conserva:

- `FunctionalAssembly`;
- componentes funcionales;
- conexiones sugeridas entre interfaces compatibles;
- joints y limites;
- grafo cinematico reconstruido;
- estado de validacion.

El dashboard muestra un resumen corto como `interfaces`, `components` y `joints` para distinguir piezas funcionales de geometria muda.

## Kinematic Authoring M1

Cuando una pieza o modelo importado tiene articulaciones ausentes o incorrectas, usar el inspector `Kinematic Authoring`:

1. Seleccionar el modelo importado.
2. Cambiar a modo `Parts`.
3. Seleccionar dos piezas con clic y `Shift` si se quiere crear una relacion nueva.
4. Pulsar `Create Joint`.
5. Definir `Parent`, `Child`, `Type`, `Axis`, `Origin` y limites.
6. Usar `Pick Origin` para seleccionar el pivot fisico directamente sobre el modelo.
7. Usar `Axis Gizmo` para orientar visualmente el eje.
8. Usar `Axis A` y `Axis B` para calcular un eje arbitrario con `normalize(B-A)`.
9. Si una pieza debe copiar otro movimiento, elegir `Mimic`, `Multiplier` y `Offset`.
10. Probar el movimiento con el slider `Test`.
11. Pulsar `Accept` si el joint es correcto o `Reject` si solo era una hipotesis.
12. Pulsar `Home` para volver a la configuracion cero.
13. Guardar el proyecto para persistir `kinematicGraph` y `kinematicState`.

Reglas importantes:

- `kinematicGraph` guarda la definicion mecanica.
- `kinematicState` guarda solo la pose actual de prueba.
- El slider no debe reimportar ni reconstruir la geometria.
- El eje puede ser arbitrario, no solo X/Y/Z.
- El origen del joint puede editarse numericamente para que el giro ocurra sobre el frame fisico correcto.
- Los helpers de pivot, frame y eje son visuales y no modifican la geometria original.
- Un gripper puede modelarse con dos joints acoplados usando multiplicadores opuestos.
- La validacion avisa de ejes invalidos, limites rotos, ciclos, duplicados, referencias inexistentes y piezas huerfanas.

## Persistencia Cinematica Y Asset Pesado

Para cerrar M1 se diferencia:

- La definicion mecanica se guarda como `kinematicGraph`.
- La pose/home se guarda como `kinematicState`.
- El asset pesado debe persistirse o referenciarse por el mecanismo de proyecto/Warehouse, no duplicarse necesariamente en `localStorage`.

Si el modelo es grande, la recuperacion correcta de M1 consiste en restaurar exactamente joints, origins, axes, parent/child, limits, mimic y estado, y resolver la geometria desde el storage persistente disponible.

## Donde Se Guardan Los Objetos

En modo desarrollo, los objetos permanentes del warehouse se guardan en:

```text
project-warehouse/<projectId>/
```

Dentro de esa carpeta debe existir:

- `manifest.json`: indice de objetos guardados.
- archivos `.glb`: piezas o conjuntos guardados como objetos 3D reales.

Una pieza guardada correctamente no debe depender de que el modelo original siga cargado en pantalla. Despues de refrescar la pagina, la pieza debe poder cargarse desde `Load Saved` o desde el boton `Import saved warehouse object to workspace`.

## Comprobacion Manual Rapida

Para confirmar que el guardado funciona:

1. Guardar piezas con `Save All`.
2. Abrir `project-warehouse/<projectId>/`.
3. Confirmar que existen archivos `.glb`.
4. Refrescar la pagina.
5. Pulsar `Load Saved`.
6. Pulsar `Import saved warehouse object to workspace`.
7. Confirmar que el objeto vuelve a aparecer en el escenario.

Si solo aumenta el contador visual pero no aparecen archivos `.glb`, el guardado permanente no se ha completado correctamente.

## Borrado Permanente

Para borrar una pieza guardada:

1. Abrir `Warehouse dashboard`.
2. Seleccionar la pieza.
3. Pulsar `Delete`.
4. Confirmar que baja el contador de objetos guardados.
5. Confirmar que el archivo correspondiente desaparece de `project-warehouse/<projectId>/`.

Para borrar desde el workspace:

1. Seleccionar el objeto en el escenario.
2. Pulsar `Delete selected object permanently` en la barra superior o usar clic derecho y `Delete permanently`.
3. Si ese objeto estaba asociado a un GLB del warehouse, se elimina tambien del manifest y del disco.
