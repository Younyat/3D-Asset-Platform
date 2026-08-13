# Manual De Uso: Warehouse, Piezas Y Workspace

Este manual describe el flujo operativo para importar un modelo completo, desmantelarlo en piezas, guardarlas de forma permanente en el warehouse del proyecto, refrescar la plataforma y volver a importar piezas guardadas al workspace.

## Objetivo Del Flujo

El objetivo es comprobar que las piezas no se quedan solo como datos temporales de la pantalla. Cada pieza guardada permanentemente debe convertirse en un objeto 3D fisico dentro del proyecto, en formato `.glb`, y debe poder volver a importarse al escenario despues de refrescar la pagina.

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
