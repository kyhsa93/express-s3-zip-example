import express, { Request, Response } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import fileUpload from 'express-fileupload';
import fs from 'fs';
import AWS from 'aws-sdk';
import { v1 } from 'uuid';
import {Entity, PrimaryColumn, Column, createConnection, ConnectionOptions } from 'typeorm';
import archiver from 'archiver';

const app = express();

app.use(helmet());
app.use(compression());
app.use(fileUpload({ useTempFiles: true, tempFileDir: './tmp/', debug: true }));
app.use(express.json());

@Entity()
class FileEntity {
  @PrimaryColumn()
  id!: string;

  @Column()
  name!: string;

  @Column()
  size!: number;

  @Column()
  mimeType!: string;
}

const databaseOption: ConnectionOptions = { synchronize:true, username: 'root', password:'test', type: 'mysql', host: 'localhost', port: 3306, database:'zipper', entities: [FileEntity]};

const s3Endpoint = 'http://localhost:4566';

const credentials = {
  accessKeyId: 'accessKeyId',
  secretAccessKey: 'secretAccessKey',
};
AWS.config.update({ region: 'region' })
const s3 = new AWS.S3({ credentials, endpoint: s3Endpoint, s3ForcePathStyle: true });

// provide html
app.get('/', (request: Request, response: Response) => {
  return response.status(200).send(`<html>
  <body>
    <form ref='uploadForm' 
      id='uploadForm' 
      action='http://localhost:5000/files' 
      method='post' 
      encType="multipart/form-data">
        <input type="file" name="sampleFile" />
        <input type='submit' value='Upload!' />
    </form>     
  </body>
</html>`)
});

// create s3 object
app.post('/files', async (request: Request, response: Response) => {
  try {
    if (!request.files || Object.keys(request.files).length === 0) {
      return response.status(400).send('No files uploaded');
    }
  
    const sampleFile = request.files.sampleFile;
  
    if (Array.isArray(sampleFile)) {
      return response.status(400).send('File array uploaded');
    }
  
    await sampleFile.mv(`./tmp/${sampleFile.name}`).catch((error) => {
      console.log(error);
      return response.status(500).send('internal server error');
    });
  
    const fileStream = fs.createReadStream(`./tmp/${sampleFile.name}`);
    fileStream.on('error', (error) => console.log('File Error', error));
    const uploadParams: AWS.S3.PutObjectRequest = { Bucket: 'bucket', Key: v1(), Body: fileStream, ACL: 'public-read' };
  
    s3.upload(uploadParams, undefined, (error, data) => {
      if (error) console.log('Error: ', error);
      console.log('updated: ', data)
    });

    const connection = await createConnection(databaseOption);

    const entity = new FileEntity();
    entity.id = uploadParams.Key;
    entity.name = sampleFile.name;
    entity.mimeType = sampleFile.mimetype;
    entity.size = sampleFile.size;

    await connection.getRepository(FileEntity).save(entity);

    await connection.close();
  
    return response.status(201).send();
  } catch(error) {
    console.log(error);
    return response.status(500).send('internal server error');
  }
});

app.post('/zips', async (request: Request, response: Response) => {
  try {
    // parse request body
    type Body = { folders: [{ name: string; documents: string[]; }]; };
    const body = request.body as Body;

    const fileIds: string[] = [];
    body.folders.map(folder => folder.documents.map(document => fileIds.push(document)));

    const nameDocumentPares: { name: string; document: string; }[] = [];
    body.folders.forEach(({ name, documents }) => documents.forEach(document => nameDocumentPares.push({ name, document })));

    // get file metadata from database
    const connection = await createConnection(databaseOption);
    const fileEntities = await connection.getRepository(FileEntity).findByIds(fileIds);
    await connection.close();
    if (fileEntities.length < 1) return response.status(404).send('file not found');
    
    const zipFileKey = `${v1()}.zip`; // .zip 을 붙여주지 않으면 file 을 s3 에서 download 받았을때 file 형식을 읽지 못합
    const output = fs.createWriteStream(zipFileKey);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(output);

    
    const folderFilePares: { folder: string; file: string }[] = [];
    nameDocumentPares.forEach(({ name, document }) => fileEntities.find(entity => document === entity.id) ? folderFilePares.push({ folder: name, file: document }) : undefined);

    folderFilePares.forEach(pare => archive.append(s3.getObject({ Bucket: 'bucket', Key: pare.file }).createReadStream(), { name: `${pare.folder}/${pare.file}` }))

    await archive.finalize();

    const readZip = fs.createReadStream(zipFileKey);
    const uploadParams: AWS.S3.PutObjectRequest = { Bucket: 'bucket', Key: zipFileKey, Body: readZip, ACL: 'public-read' };

    s3.upload(uploadParams, undefined, (error, data) => {
      if (error) console.log('update error: ', error);
      console.log('updated: ', data);
    });

    return response.status(201).send(`http://localhost:4566/bucket/${zipFileKey}`);
  } catch (error) {
    console.log(error);
    return response.status(500).send('internal server error');
  }
});

// get zipped s3 object
app.get('/files', async (request: Request, response: Response) => {
  try {
    const connection = await createConnection(databaseOption);

    const fileEntities = await connection.getRepository(FileEntity).find();
    await connection.close();

    const getParams = { Bucket: 'bucket', Key: fileEntities[0].id };

    const data = s3.getObject(getParams, (error, data) => {
      if (error) console.log(error);
      return data.Body?.toString('utf-8')
    });

    console.log('localstack response: ', data);

    console.log('file entities', fileEntities);
    return response.status(200).send(data);
  } catch (error) {
    console.log(error);
    return response.status(500).send();
  }
});

app.listen(5000, () => console.log('express app listen on port 5000'));


// 'use strict';

// const AWS = require("aws-sdk");
// AWS.config.update( { region: "eu-west-1" } );
// const s3 = new AWS.S3( { apiVersion: '2006-03-01'} );

// const   _archiver = require('archiver');

// //This returns us a stream.. consider it as a real pipe sending fluid to S3 bucket.. Don't forget it
// const streamTo = (_bucket, _key) => {
// 	var stream = require('stream');
// 	var _pass = new stream.PassThrough();
// 	s3.upload( { Bucket: _bucket, Key: _key, Body: _pass }, (_err, _data) => { /*...Handle Errors Here*/ } );
// 	return _pass;
// };
      
// exports.handler = async (_req, _ctx, _cb) => {
// 	var _keys = ['list of your file keys in s3'];
	
//     var _list = await Promise.all(_keys.map(_key => new Promise((_resolve, _reject) => {
//             s3.getObject({Bucket:'bucket-name', Key:_key})
//                 .then(_data => _resolve( { data: _data.Body, name: `${_key.split('/').pop()}` } ));
//         }
//     ))).catch(_err => { throw new Error(_err) } );

//     await new Promise((_resolve, _reject) => { 
//         var _myStream = streamTo('bucket-name', 'fileName.zip');		//Now we instantiate that pipe...
//         var _archive = _archiver('zip');
//         _archive.on('error', err => { throw new Error(err); } );
        
//         //Your promise gets resolved when the fluid stops running... so that's when you get to close and resolve
//         _myStream.on('close', _resolve);
//         _myStream.on('end', _resolve);
//         _myStream.on('error', _reject);
        
//         _archive.pipe(_myStream);			//Pass that pipe to _archive so it can push the fluid straigh down to S3 bucket
//         _list.forEach(_itm => _archive.append(_itm.data, { name: _itm.name } ) );		//And then we start adding files to it
//         _archive.finalize();				//Tell is, that's all we want to add. Then when it finishes, the promise will resolve in one of those events up there
//     }).catch(_err => { throw new Error(_err) } );
    
//     _cb(null, { } );		//Handle response back to server
// };
