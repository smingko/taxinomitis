// external dependencies
import * as Express from 'express';
import * as httpstatus from 'http-status';
// local dependencies
import * as auth from './auth';
import * as store from '../db/store';
import * as Objects from '../db/db-types';
import * as dbobjects from '../db/objects';
import * as users from '../auth0/users';
import * as Users from '../auth0/auth-types';
import * as urls from './urls';
import * as sound from '../training/sound';
import * as errors from './errors';
import * as headers from './headers';
import loggerSetup from '../utils/logger';

const log = loggerSetup();


interface ProjectWithOwner extends Objects.Project {
    owner?: Users.Student;
    hasModel?: boolean;
    classifierId?: string;
}



function getProjectsByClassId(req: Express.Request, res: Express.Response) {
    const classid: string = req.params.classid;

    const responsePromises: [Promise<{[id: string]: Users.Student }>,
                             Promise<Objects.Project[]>,
                             Promise<{[projectid: string]: string}>] =
        [
            users.getStudentsByUserId(classid),
            store.getProjectsByClassId(classid),
            store.getProjectsWithBluemixClassifiers(classid),
        ];

    Promise.all(responsePromises)
        .then((response) => {
            const students = response[0];
            const projects = response[1];
            const projectIdsWithModels = response[2];

            const ownedProjects: ProjectWithOwner[] = projects.map((project) => {
                const ownedProject: ProjectWithOwner = project;
                ownedProject.owner = students[project.userid];

                if (projectIdsWithModels[project.id]) {
                    ownedProject.hasModel = true;
                    ownedProject.classifierId = projectIdsWithModels[project.id];
                }
                else {
                    ownedProject.hasModel = false;
                }

                return ownedProject;
            });

            return res.json(ownedProjects);
        })
        .catch((err) => {
            log.error({ err, func : 'getProjectsByClassId' }, 'Server error');
            errors.unknownError(res, err);
        });
}


function getProjectsByUserId(req: Express.Request, res: Express.Response) {
    const classid: string = req.params.classid;
    const userid: string = req.params.studentid;

    store.getProjectsByUserId(userid, classid)
        .then((projects: Objects.Project[]) => {
            res.set(headers.NO_CACHE).json(projects);
        })
        .catch((err) => {
            log.error({ err, func : 'getProjectsByUserId' }, 'Server error');
            errors.unknownError(res, err);
        });
}


async function createProject(req: auth.RequestWithUser, res: Express.Response) {
    const classid: string = req.params.classid;
    const userid: string = req.params.studentid;

    if (!req.body || !req.body.type || !req.body.name) {
        return res.status(httpstatus.BAD_REQUEST)
                  .send({ error : 'Missing required field' });
    }
    if (dbobjects.VALID_PROJECT_NAME.test(req.body.name) === false) {
        return res.status(httpstatus.BAD_REQUEST)
                  .send({ error : 'Invalid project name' });
    }
    if (req.body.type === 'text' && !req.body.language) {
        return res.status(httpstatus.BAD_REQUEST)
                  .send({ error : 'Missing required field' });
    }

    const numProjects = await store.countProjectsByUserId(userid, classid);
    const tenantPolicy = await store.getClassTenant(classid);

    if (numProjects >= tenantPolicy.maxProjectsPerUser) {
        return res.status(httpstatus.CONFLICT)
                  .send({ error : 'User already has maximum number of projects' });
    }
    if (tenantPolicy.supportedProjectTypes.indexOf(req.body.type) === -1) {
        return res.status(httpstatus.FORBIDDEN)
                  .send({ error : 'Support for ' + req.body.type + ' projects is not enabled for your class' });
    }

    // only teachers are allowed to create crowdsourced projects
    let crowdsourced: boolean = false;
    if (req.body.isCrowdSourced) {
        if (req.user.app_metadata.role !== 'supervisor') {
            return res.status(httpstatus.FORBIDDEN)
                      .send({ error : 'Only teachers or group leaders can create crowd-sourced projects' });
        }
        else {
            crowdsourced = true;
        }
    }


    try {
        const project = await store.storeProject(userid, classid,
            req.body.type,
            req.body.name,
            req.body.language,
            req.body.fields,
            crowdsourced);


        if (project.type === 'sounds') {
            await store.addLabelToProject(userid, classid, project.id, sound.BACKGROUND_NOISE);
        }
        return res.status(httpstatus.CREATED).json(project);
    }
    catch (err) {
        if (err.statusCode === httpstatus.BAD_REQUEST) {
            return res.status(httpstatus.BAD_REQUEST).json({ error : err.message });
        }
        log.error({ err, func : 'createProject' }, 'Server error');
        errors.unknownError(res, err);
    }
}


function getProject(req: auth.RequestWithProject, res: Express.Response) {
    return res.set(headers.NO_CACHE).json(req.project);
}


function getProjectFields(req: Express.Request, res: Express.Response) {
    const classid: string = req.params.classid;
    const userid: string = req.params.studentid;
    const projectid: string = req.params.projectid;

    return store.getNumberProjectFields(userid, classid, projectid)
        .then((fields: Objects.NumbersProjectField[]) => {
            if (fields && fields.length > 0) {
                return res.set(headers.NO_CACHE).json(fields);
            }
            else {
                return errors.notFound(res);
            }
        })
        .catch((err) => {
            log.error({ err, func : 'getProjectFields' }, 'Server error');
            errors.unknownError(res, err);
        });
}



async function deleteProject(req: auth.RequestWithProject, res: Express.Response) {
    const classid = req.params.classid;
    const userid = req.params.studentid;
    const projectid = req.params.projectid;

    try {
        const project: Objects.Project = req.project;

        // if this is an images project, schedule a job to clean up
        //  any usage of the S3 Object Store by the training images
        if (project.type === 'images') {
            await store.storeDeleteProjectImagesJob(classid, userid, projectid);
        }

        await store.deleteEntireProject(userid, classid, project);
        return res.sendStatus(httpstatus.NO_CONTENT);
    }
    catch (err) {
        log.error({ err, func : 'deleteProject' }, 'Server error');
        errors.unknownError(res, err);
    }
}





function getProjectPatch(req: Express.Request) {
    const patchRequests = req.body;

    if (Array.isArray(patchRequests) === false) {
        throw new Error('PATCH body should be an array');
    }

    if (patchRequests.length !== 1) {
        throw new Error('Only individual PATCH requests are supported');
    }

    const patchRequest = patchRequests[0];

    if (patchRequest.path !== '/labels') {
        throw new Error('Only modifications to project labels are supported');
    }

    if (!patchRequest.op) {
        throw new Error('PATCH requests must include an op');
    }
    const op: string = patchRequest.op;

    if (!patchRequest.value) {
        throw new Error('PATCH requests must include a value');
    }
    let value = patchRequest.value;
    if (op === 'add' || op === 'remove') {
        if (typeof value !== 'string') {
            throw new Error('PATCH requests to add or remove a label should specify a string');
        }
        value = value.trim();
        if (value.length === 0) {
            throw new Error('Cannot add an empty label');
        }
        if (value.length > Objects.MAX_LABEL_LENGTH) {
            throw new Error('Label exceeds max length');
        }
    }
    else if (op === 'replace') {
        if (Array.isArray(value) === false) {
            throw new Error('PATCH requests to replace labels should specify an array');
        }
        value = value.map((item: any) => item.toString().trim())
                     .filter((item: any) => item);

        for (const item of value) {
            if (item.length > Objects.MAX_LABEL_LENGTH) {
                throw new Error('Label exceeds max length');
            }
        }
    }
    else {
        throw new Error('Invalid PATCH op');
    }

    return { op, value };
}


async function deleteImages(classid: string, userid: string, projectid: string, label: string): Promise<void> {
    const imagesToDelete = await store.getStoredImageTraining(projectid, label);
    for (const imageToDelete of imagesToDelete) {
        await store.storeDeleteImageJob(classid, userid, projectid, imageToDelete.id);
    }
}


async function modifyProject(req: Express.Request, res: Express.Response) {
    const classid = req.params.classid;
    const userid = req.params.studentid;
    const projectid = req.params.projectid;

    let patch;
    try {
        patch = getProjectPatch(req);
    }
    catch (err) {
        return res.status(httpstatus.BAD_REQUEST)
                  .json({
                      error : err.message,
                  });
    }

    try {
        let response: string[];

        switch (patch.op) {
        case 'add':
            response = await store.addLabelToProject(userid, classid, projectid, patch.value);
            break;
        case 'remove':
            // delete anything with the label from the S3 Object Store
            await deleteImages(classid, userid, projectid, patch.value);
            // delete anything with the label from the MySQL DB
            response = await store.removeLabelFromProject(userid, classid, projectid, patch.value);
            break;
        case 'replace':
            response = await store.replaceLabelsForProject(userid, classid, projectid, patch.value);
            break;
        default:
            response = [];
        }

        res.json(response);
    }
    catch (err) {
        if (err.message === 'No room for the label') {
            return res.status(httpstatus.BAD_REQUEST).json({ error : err.message });
        }
        log.error({ err, func : 'modifyProject' }, 'Server error');
        return errors.unknownError(res, err);
    }
}



export default function registerApis(app: Express.Application) {

    app.get(urls.ALL_CLASS_PROJECTS,
            auth.authenticate,
            auth.checkValidUser,
            auth.requireSupervisor,
            getProjectsByClassId);

    app.get(urls.PROJECTS,
            auth.authenticate,
            auth.checkValidUser,
            getProjectsByUserId);

    app.post(urls.PROJECTS,
            auth.authenticate,
            auth.checkValidUser,
            // @ts-ignore
            createProject);

    app.get(urls.PROJECT,
            auth.authenticate,
            auth.checkValidUser,
            auth.verifyProjectAccess,
            // @ts-ignore
            getProject);

    app.get(urls.FIELDS,
            auth.authenticate,
            auth.checkValidUser,
            getProjectFields);

    app.delete(urls.PROJECT,
            auth.authenticate,
            auth.checkValidUser,
            auth.verifyProjectOwner,
            // @ts-ignore
            deleteProject);

    app.patch(urls.PROJECT,
            auth.authenticate,
            auth.checkValidUser,
            auth.verifyProjectOwner,
            modifyProject);
}
